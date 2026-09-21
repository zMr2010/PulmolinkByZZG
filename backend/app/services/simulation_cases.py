import json
import logging
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from app.config import Settings
from app.errors import APIError
from app.services.storage import stored_path

logger = logging.getLogger(__name__)
CASE_ID = re.compile(r"^sim_[0-9a-f]{32}$")
_status_lock = RLock()


def _now() -> str:
    return datetime.now(UTC).isoformat()


def case_root(settings: Settings, case_id: str) -> Path:
    if not CASE_ID.fullmatch(case_id):
        raise APIError(404, 40412, "Simulation case not found")
    return stored_path(settings, f"simulation-cases/{case_id}")


def _status_path(settings: Settings, case_id: str) -> Path:
    return case_root(settings, case_id) / "status.json"


def create_status(
    settings: Settings,
    case_id: str,
    *,
    owner_user_id: int,
    source_filename: str,
    source_path: Path,
) -> dict:
    now = _now()
    status = {
        "case_id": case_id,
        "owner_user_id": owner_user_id,
        "source_filename": Path(source_filename).name,
        "source_path": source_path.name,
        "status": "PENDING",
        "progress": 0,
        "manifest_url": None,
        "error_code": None,
        "error_message": None,
        "created_at": now,
        "updated_at": now,
    }
    _write_status(settings, case_id, status)
    return status


def read_status(settings: Settings, case_id: str) -> dict:
    path = _status_path(settings, case_id)
    try:
        with _status_lock, path.open(encoding="utf-8") as source:
            value = json.load(source)
    except (FileNotFoundError, json.JSONDecodeError):
        raise APIError(404, 40412, "Simulation case not found") from None
    if value.get("case_id") != case_id:
        raise APIError(404, 40412, "Simulation case not found")
    return value


def _write_status(settings: Settings, case_id: str, value: dict) -> None:
    path = _status_path(settings, case_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with _status_lock:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)


def update_status(settings: Settings, case_id: str, **changes) -> dict:
    with _status_lock:
        status = read_status(settings, case_id)
        status.update(changes)
        status["updated_at"] = _now()
        _write_status(settings, case_id, status)
    return status


def public_status(status: dict) -> dict:
    return {
        key: status.get(key)
        for key in (
            "case_id",
            "source_filename",
            "status",
            "progress",
            "manifest_url",
            "error_code",
            "error_message",
            "created_at",
            "updated_at",
        )
    }


def run_simulation_case(settings: Settings, case_id: str) -> None:
    status = read_status(settings, case_id)
    model_root = settings.nv_segment_ct_dir
    if model_root is None or not model_root.is_dir():
        update_status(
            settings,
            case_id,
            status="FAILED",
            progress=0,
            error_code="MODEL_UNAVAILABLE",
            error_message="NV-Segment-CTMR runtime is not configured",
        )
        return

    root = case_root(settings, case_id)
    source_path = root / status["source_path"]
    output = root / "output"
    work_dir = root / "work"
    backend_root = Path(__file__).resolve().parents[2]
    script = backend_root / "scripts" / "build_simulation_case.py"
    command = [
        sys.executable,
        str(script),
        "--image",
        str(source_path),
        "--model-root",
        str(model_root),
        "--work-dir",
        str(work_dir),
        "--output",
        str(output),
        "--asset-prefix",
        f"/api/v1/simulation-cases/{case_id}/assets",
        "--case-id",
        case_id,
        "--device",
        settings.nv_segment_device,
        "--spacing",
        *(str(value) for value in settings.nv_segment_spacing),
        "--roi",
        *(str(value) for value in settings.nv_segment_roi_size),
        "--overlap",
        str(settings.nv_segment_overlap),
        "--sw-batch-size",
        str(settings.nv_segment_sw_batch_size),
        "--min-voxels",
        str(settings.segmentation_min_component_voxels),
        "--organ-faces",
        str(settings.segmentation_target_faces),
    ]
    last_lines: list[str] = []
    try:
        update_status(settings, case_id, status="SEGMENTING", progress=2)
        process = subprocess.Popen(
            command,
            cwd=backend_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.strip()
            if not line:
                continue
            last_lines = (last_lines + [line])[-8:]
            if line.startswith("segmentation="):
                try:
                    value = int(line.split("=", 1)[1].rstrip("%"))
                    update_status(settings, case_id, status="SEGMENTING", progress=min(68, 5 + round(value * 0.63)))
                except ValueError:
                    pass
            elif line.startswith("meshing="):
                update_status(settings, case_id, status="MESH_PROCESSING", progress=75)
        return_code = process.wait()
        manifest = output / "manifest.json"
        if return_code != 0 or not manifest.is_file():
            raise RuntimeError(f"builder exited with code {return_code}")
        update_status(
            settings,
            case_id,
            status="READY",
            progress=100,
            manifest_url=f"/api/v1/simulation-cases/{case_id}/manifest",
            error_code=None,
            error_message=None,
        )
    except Exception as exc:
        logger.error(
            "Simulation case build failed (%s); tail=%s",
            type(exc).__name__,
            " | ".join(last_lines[-3:]),
        )
        update_status(
            settings,
            case_id,
            status="FAILED",
            progress=0,
            error_code="BUILD_FAILED",
            error_message="Simulation assets could not be generated from this CT",
        )
