import json
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, File, UploadFile
from fastapi.responses import FileResponse

from app.audit import audit
from app.deps import DB, Config, CurrentUser, require_doctor
from app.errors import APIError, Envelope, success
from app.schemas import SimulationCaseOut
from app.services.imaging import load_volume
from app.services.simulation_cases import (
    case_root,
    create_status,
    public_status,
    read_status,
    run_simulation_case,
)
from app.services.uploads import stream_upload

router = APIRouter(tags=["Surgery Simulation"])


def _authorized_status(settings, db, user, case_id: str) -> dict:
    require_doctor(db, user)
    status = read_status(settings, case_id)
    if status["owner_user_id"] != user.id and user.role != "admin":
        raise APIError(403, 40301, "No permission to access this simulation case")
    return status


@router.post(
    "/simulation-cases",
    status_code=202,
    response_model=Envelope[SimulationCaseOut],
)
def create_simulation_case(
    background_tasks: BackgroundTasks,
    db: DB,
    user: CurrentUser,
    settings: Config,
    file: UploadFile = File(),
):
    require_doctor(db, user)
    filename = Path(file.filename or "").name
    lower_name = filename.lower()
    if not (lower_name.endswith(".nii") or lower_name.endswith(".nii.gz")):
        file.file.close()
        raise APIError(400, 40004, "Simulation CT must be a .nii or .nii.gz file")

    case_id = f"sim_{uuid4().hex}"
    root = case_root(settings, case_id)
    extension = ".nii.gz" if lower_name.endswith(".nii.gz") else ".nii"
    source_path = root / f"source{extension}"
    try:
        stream_upload(file, source_path, settings.max_upload_bytes)
        # Validate before accepting the job. The file is deliberately not added
        # to MedicalImage and is not associated with the imaging-page workflow.
        _, data = load_volume(source_path, settings)
        del data
        status = create_status(
            settings,
            case_id,
            owner_user_id=user.id,
            source_filename=filename,
            source_path=source_path,
        )
        audit(
            db,
            user.id,
            None,
            "simulation.create",
            "simulation_case",
            case_id,
            after={"source_filename": filename},
        )
        db.commit()
    except Exception:
        db.rollback()
        source_path.unlink(missing_ok=True)
        (root / "status.json").unlink(missing_ok=True)
        try:
            root.rmdir()
        except OSError:
            pass
        raise
    background_tasks.add_task(run_simulation_case, settings, case_id)
    return success(public_status(status))


@router.get("/simulation-cases/{case_id}", response_model=Envelope[SimulationCaseOut])
def get_simulation_case(case_id: str, db: DB, user: CurrentUser, settings: Config):
    return success(public_status(_authorized_status(settings, db, user, case_id)))


@router.get("/simulation-cases/{case_id}/manifest", response_model=Envelope[dict])
def get_simulation_manifest(case_id: str, db: DB, user: CurrentUser, settings: Config):
    status = _authorized_status(settings, db, user, case_id)
    if status["status"] != "READY":
        raise APIError(409, 40920, "Simulation case is not ready")
    path = case_root(settings, case_id) / "output" / "manifest.json"
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise APIError(404, 40412, "Simulation manifest not found") from None
    return success(manifest)


@router.get("/simulation-cases/{case_id}/assets/{asset_path:path}", response_class=FileResponse)
def get_simulation_asset(
    case_id: str,
    asset_path: str,
    db: DB,
    user: CurrentUser,
    settings: Config,
):
    status = _authorized_status(settings, db, user, case_id)
    if status["status"] != "READY":
        raise APIError(409, 40920, "Simulation case is not ready")
    output = (case_root(settings, case_id) / "output").resolve()
    path = (output / asset_path).resolve()
    if not path.is_relative_to(output) or not path.is_file() or path.suffix.lower() != ".glb":
        raise APIError(404, 40412, "Simulation asset not found")
    return FileResponse(
        path,
        media_type="model/gltf-binary",
        headers={"Cache-Control": "private, max-age=86400"},
    )
