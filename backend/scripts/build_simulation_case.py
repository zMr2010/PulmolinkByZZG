"""Build browser simulation assets from an NV-Segment-CTMR all-label result.

This is an offline preprocessing command. It reuses the project's segmentation
adapter and geometry engine; no model inference code is duplicated here.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import nibabel as nib
import numpy as np
import scipy.ndimage as ndi
import trimesh

try:
    import fast_simplification
except ImportError:
    fast_simplification = None

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.adapters.nv_segment_ct import NVSegmentCT  # noqa: E402
from app.services.geometry_engine import (  # noqa: E402
    extract_subvoxel_surface_from_mask,
    get_srgb_for_organ,
)
from app.services.glb import export_mesh_glb  # noqa: E402
from app.services.label_catalog import LabelCatalog  # noqa: E402


@dataclass(slots=True)
class RuntimeSettings:
    nv_segment_ct_dir: Path
    nv_segment_device: str
    nv_segment_spacing: tuple[float, float, float]
    nv_segment_roi_size: tuple[int, int, int]
    nv_segment_overlap: float
    nv_segment_sw_batch_size: int
    segmentation_min_component_voxels: int


def slug(value: str) -> str:
    normalized = "".join(character.lower() if character.isalnum() else "_" for character in value)
    return "_".join(part for part in normalized.split("_") if part) or "structure"


def hex_color(label_name: str) -> str:
    red, green, blue, *_ = get_srgb_for_organ(label_name)
    return f"#{red:02x}{green:02x}{blue:02x}"


def structure_type(group_id: str, label_name: str) -> str:
    value = f"{group_id} {label_name}".lower()
    if any(token in value for token in ("rib", "vertebra", "bone", "skull", "sternum", "sacrum", "femur", "hip")):
        return "bone"
    return "organ"


def largest_body_mask(image: nib.Nifti1Image) -> np.ndarray:
    """Extract a patient envelope without retaining the CT couch.

    A global 3-D largest-component threshold is not sufficient here: the skin
    often touches the couch, so both become one component and marching cubes
    produces a large rectangular slab.  Selecting the patient independently in
    every axial slice also handles truncated acquisitions more gracefully.
    """
    values = np.asanyarray(image.dataobj, dtype=np.float32)
    threshold = values > -500.0
    body = np.zeros(threshold.shape, dtype=bool)
    width, height, depth = threshold.shape
    center = np.asarray((width * 0.5, height * 0.5), dtype=np.float64)
    structure = ndi.generate_binary_structure(2, 2)

    for slice_index in range(depth):
        plane = threshold[:, :, slice_index].copy()

        # Opening severs remaining narrow skin/couch bridges. Fill enclosed air
        # before opening so a tiny cavity cannot permanently erode valid body
        # voxels; closing and a second fill smooth the selected component.
        plane = ndi.binary_fill_holes(plane)
        opened = ndi.binary_opening(plane, structure=structure, iterations=2)
        labels, count = ndi.label(opened, structure=structure)
        if not count:
            continue

        best_label = 0
        best_score = -np.inf
        for label_id in range(1, count + 1):
            coordinates = np.argwhere(labels == label_id)
            size = len(coordinates)
            if size < 64:
                continue
            centroid = coordinates.mean(axis=0)
            normalized_distance = np.linalg.norm((centroid - center) / np.asarray((width, height)))
            touches_lateral_border = (
                np.any(coordinates[:, 0] == 0)
                or np.any(coordinates[:, 0] == width - 1)
            )
            border_penalty = 0.35 if touches_lateral_border else 1.0
            score = size * border_penalty / (1.0 + normalized_distance * 3.0)
            if score > best_score:
                best_label = label_id
                best_score = score

        if not best_label:
            continue
        patient = labels == best_label
        patient = ndi.binary_closing(patient, structure=structure, iterations=3)
        body[:, :, slice_index] = ndi.binary_fill_holes(patient)

    if not np.any(body):
        raise ValueError("CT body-envelope threshold produced an empty mask")

    # Smooth one-voxel slice discontinuities without reconnecting the couch.
    padded = np.pad(body, ((0, 0), (0, 0), (1, 1)), mode="edge")
    body = ndi.binary_closing(
        padded,
        structure=ndi.generate_binary_structure(3, 1),
        iterations=1,
    )[:, :, 1:-1]
    del values, threshold
    return body


def downsample_mask_with_affine(mask: np.ndarray, affine: np.ndarray, factor: int) -> tuple[np.ndarray, np.ndarray]:
    if factor <= 1:
        return mask, np.asarray(affine, dtype=float)
    sampled = mask[::factor, ::factor, ::factor]
    sampled_affine = np.asarray(affine, dtype=float).copy()
    sampled_affine[:3, :3] = sampled_affine[:3, :3] @ np.diag([factor, factor, factor])
    return sampled, sampled_affine


def inner_soft_tissue_mask(
    body_mask: np.ndarray,
    affine: np.ndarray,
    inset_mm: float,
) -> np.ndarray:
    """Create a CT-derived inner layer using physical, not voxel, distance."""
    if inset_mm <= 0:
        raise ValueError("Soft-tissue inset must be positive")
    spacing_mm = np.linalg.norm(np.asarray(affine, dtype=float)[:3, :3], axis=0)
    if np.any(~np.isfinite(spacing_mm)) or np.any(spacing_mm <= 0):
        raise ValueError("Soft-tissue generation requires a valid physical affine")
    distance_mm = ndi.distance_transform_edt(body_mask, sampling=spacing_mm)
    inner = distance_mm >= float(inset_mm)
    if not np.any(inner):
        raise ValueError("Soft-tissue inset removed the entire body mask")
    labels, count = ndi.label(inner)
    if count > 1:
        sizes = np.bincount(labels.ravel())
        sizes[0] = 0
        inner = labels == int(np.argmax(sizes))
    return inner


def retain_anatomical_components(
    mask: np.ndarray,
    *,
    min_voxels: int,
    relative_to_largest: float = 0.12,
) -> np.ndarray:
    """Keep major anatomical pieces while rejecting distant prompt artifacts.

    Some prompted NV labels contain a small false-positive island that still
    exceeds a fixed voxel cutoff.  A relative cutoff removes those islands
    without assuming a fixed organ list; genuinely multipart structures such
    as colon retain every component of meaningful size.
    """
    labels, count = ndi.label(mask)
    if count <= 1:
        return mask.astype(bool)
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    largest = int(sizes.max())
    cutoff = max(int(min_voxels), int(np.ceil(largest * relative_to_largest)))
    keep = np.flatnonzero(sizes >= cutoff)
    if not len(keep):
        keep = np.asarray([int(np.argmax(sizes))])
    return np.isin(labels, keep)


def enforce_web_face_budget(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    """Create a separate browser display mesh even if the strict medical QEM gate falls back."""
    if fast_simplification is None or len(mesh.faces) <= int(target_faces * 1.1):
        return mesh
    # A very aggressive target can open a tiny hole even when a slightly
    # denser QEM result remains watertight. Select the lowest safe tier rather
    # than falling all the way back to a several-hundred-thousand-face mesh.
    source = mesh
    for _stage in range(3):
        safe_candidate = None
        tiers = [target_faces * factor for factor in (1, 2, 3, 4, 6, 8)]
        for face_count in tiers:
            if face_count >= len(source.faces):
                break
            vertices, faces = fast_simplification.simplify(
                source.vertices,
                source.faces,
                target_count=int(face_count),
                agg=4,
            )
            candidate = trimesh.Trimesh(vertices=vertices, faces=faces, process=True)
            candidate.remove_unreferenced_vertices()
            candidate.fix_normals()
            if not np.all(np.isfinite(candidate.vertices)) or not len(candidate.faces):
                continue
            if mesh.is_watertight and not candidate.is_watertight:
                continue
            safe_candidate = candidate
            break
        if safe_candidate is None or len(safe_candidate.faces) >= len(source.faces):
            return source
        source = safe_candidate
        if len(source.faces) <= target_faces * 3:
            return source
    return source


def export_structure(
    *,
    mask: np.ndarray,
    affine: np.ndarray,
    output_root: Path,
    asset_prefix: str,
    structure_id: str,
    name: str,
    style_name: str,
    type_name: str,
    label_id: int | None,
    target_faces: int,
    min_voxels: int,
    visible: bool = True,
) -> dict:
    mesh, metadata = extract_subvoxel_surface_from_mask(
        mask=mask,
        affine=affine,
        target_faces=target_faces,
        organ_id=style_name,
        min_component_voxels=min_voxels,
        smooth_iterations=2 if type_name == "body" else 1,
        sdf_sigma=1.2,
    )
    source_faces = len(mesh.faces)
    mesh = enforce_web_face_budget(mesh, target_faces)
    metadata["source_faces"] = source_faces
    metadata["faces"] = len(mesh.faces)
    metadata["is_watertight"] = bool(mesh.is_watertight)
    folder = output_root / structure_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "visual.glb").write_bytes(export_mesh_glb(mesh))
    deformable = type_name != "bone"
    is_body_layer = type_name in {"body", "soft_tissue"}
    return {
        "id": structure_id,
        "name": name,
        "labelId": label_id,
        "type": type_name,
        "visualMesh": f"{asset_prefix.rstrip('/')}/{structure_id}/visual.glb",
        "physicsMesh": None,
        "binding": None,
        "deformable": deformable,
        "visible": visible,
        "physicsMode": "KINEMATIC" if deformable else "STATIC",
        "material": {
            "color": "#d9ab92" if type_name == "body" else "#b9666d" if type_name == "soft_tissue" else hex_color(style_name),
            "opacity": 1.0,
            "roughness": 0.62 if type_name == "body" else 0.72 if type_name == "soft_tissue" else 0.42,
            # The closed body envelope is rendered front-side only so an
            # incision reveals organs instead of the posterior skin wall.
            "doubleSided": not is_body_layer,
        },
        "metadata": {
            "source": "NV-Segment-CTMR" if label_id is not None else "CT-derived soft-tissue envelope" if type_name == "soft_tissue" else "CT body-envelope threshold",
            "cuttableThicknessMm": 18 if type_name == "body" else 45 if type_name == "soft_tissue" else 30,
            "faces": int(metadata["faces"]),
            "sourceFaces": int(metadata["source_faces"]),
            "isWatertight": bool(metadata["is_watertight"]),
            "volumeCm3": float(metadata["volume_cm3"]),
        },
    }


def build(args: argparse.Namespace) -> Path:
    image_path = args.image.resolve()
    model_root = args.model_root.resolve()
    work_dir = args.work_dir.resolve()
    output_root = args.output.resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    output_root.mkdir(parents=True, exist_ok=True)
    settings = RuntimeSettings(
        nv_segment_ct_dir=model_root,
        nv_segment_device=args.device,
        nv_segment_spacing=tuple(args.spacing),
        nv_segment_roi_size=tuple(args.roi),
        nv_segment_overlap=args.overlap,
        nv_segment_sw_batch_size=args.sw_batch_size,
        segmentation_min_component_voxels=args.min_voxels,
    )
    adapter = NVSegmentCT(settings)  # type: ignore[arg-type]
    label_path = work_dir / "label_map_1mm.nii.gz"
    if not label_path.is_file():
        if not adapter.available():
            raise RuntimeError("NV-Segment-CTMR model/runtime is not available in the selected Python environment")
        result = adapter.run_batch(
            image_path=image_path,
            output_dir=work_dir,
            progress=lambda value: print(f"segmentation={value}%", flush=True),
            modality="CT_BODY",
            label_ids=args.prompt_labels,
        )
        label_path = Path(result["label_map_1mm"])

    label_image = nib.load(str(label_path))
    label_values = np.asanyarray(label_image.dataobj)
    labels, counts = np.unique(label_values, return_counts=True)
    catalog = LabelCatalog(model_root)
    detected = [
        (int(label), int(count))
        for label, count in zip(labels, counts, strict=False)
        if int(label) > 0 and int(count) >= args.min_voxels
    ]
    structures: list[dict] = []
    ct_image = nib.load(str(image_path))
    print("meshing=body", flush=True)
    body_mask, body_affine = downsample_mask_with_affine(
        largest_body_mask(ct_image), ct_image.affine, args.body_downsample,
    )
    structures.append(export_structure(
        mask=body_mask, affine=body_affine, output_root=output_root,
        asset_prefix=args.asset_prefix, structure_id="body", name="Body / Skin", type_name="body",
        label_id=None, style_name="body", target_faces=args.body_faces, min_voxels=args.min_voxels,
    ))
    print("meshing=soft_tissue", flush=True)
    structures.append(export_structure(
        mask=inner_soft_tissue_mask(body_mask, body_affine, args.soft_tissue_inset_mm),
        affine=body_affine, output_root=output_root,
        asset_prefix=args.asset_prefix, structure_id="soft_tissue", name="Soft tissue envelope",
        type_name="soft_tissue", label_id=None, style_name="soft_tissue",
        target_faces=args.soft_tissue_faces, min_voxels=args.min_voxels, visible=False,
    ))
    used_ids = {"body", "soft_tissue"}
    for index, (label_id, count) in enumerate(detected, start=1):
        description = catalog.describe(label_id)
        base_id = slug(str(description["group_id"] or description["organ_id"]))
        structure_id = base_id if base_id not in used_ids else f"{base_id}_{label_id}"
        used_ids.add(structure_id)
        label_name = str(description["name"])
        type_name = structure_type(str(description["group_id"]), label_name)
        print(f"meshing={index}/{len(detected)} label={label_id} name={label_name} voxels={count}", flush=True)
        try:
            structures.append(export_structure(
                mask=retain_anatomical_components(
                    label_values == label_id,
                    min_voxels=args.min_voxels,
                ),
                affine=label_image.affine, output_root=output_root,
                asset_prefix=args.asset_prefix, structure_id=structure_id,
                name=str(description["display_name"] or label_name), style_name=label_name, type_name=type_name,
                label_id=label_id, target_faces=args.organ_faces, min_voxels=args.min_voxels,
            ))
        except ValueError as error:
            print(f"skipped label={label_id}: {error}", flush=True)

    manifest = {
        "schemaVersion": "1.0",
        "id": args.case_id,
        "caseId": args.case_id,
        "name": f"NV-Segment-CTMR case {args.case_id}",
        "coordinateSystem": "GLTF_Y_UP",
        "units": "meter",
        "sourceToSimulation": [
            -0.001, 0, 0, 0,
            0, 0, 0.001, 0,
            0, 0.001, 0, 0,
            0, 0, 0, 1,
        ],
        "metadata": {
            "purpose": "research-and-teaching-only",
            "segmentationProvider": "NV-Segment-CTMR",
            "sourceImage": image_path.name,
            "sourceShape": list(ct_image.shape),
            "sourceSpacingMm": [float(value) for value in ct_image.header.get_zooms()[:3]],
            "sourceOrientation": "".join(nib.aff2axcodes(ct_image.affine)),
        },
        "structures": structures,
    }
    manifest_path = output_root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"manifest={manifest_path} structures={len(structures)}", flush=True)
    return manifest_path


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser()
    command.add_argument("--image", type=Path, required=True)
    command.add_argument("--model-root", type=Path, required=True)
    command.add_argument("--work-dir", type=Path, required=True)
    command.add_argument("--output", type=Path, required=True)
    command.add_argument("--asset-prefix", default="/simulation/tcga-zf-aa5n")
    command.add_argument("--case-id", default="tcga-zf-aa5n")
    command.add_argument("--device", default="auto")
    command.add_argument("--spacing", nargs=3, type=float, default=(1.5, 1.5, 1.5))
    command.add_argument("--roi", nargs=3, type=int, default=(192, 192, 128))
    command.add_argument("--overlap", type=float, default=0.3)
    command.add_argument("--sw-batch-size", type=int, default=1)
    command.add_argument("--min-voxels", type=int, default=5000)
    command.add_argument("--body-faces", type=int, default=60000)
    command.add_argument("--body-downsample", type=int, default=2)
    command.add_argument("--soft-tissue-faces", type=int, default=50000)
    command.add_argument("--soft-tissue-inset-mm", type=float, default=14.0)
    command.add_argument("--organ-faces", type=int, default=40000)
    command.add_argument(
        "--prompt-labels",
        nargs="+",
        type=int,
        help="Optional NV metadata label ids to infer together; omitted uses the model's all-label CT mode.",
    )
    return command


if __name__ == "__main__":
    build(parser().parse_args())
