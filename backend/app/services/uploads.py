from pathlib import Path

from fastapi import UploadFile

from app.errors import APIError


def stream_upload(upload: UploadFile, destination: Path, max_bytes: int) -> int:
    """Copy a spooled multipart upload without materializing the whole file in RAM."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    try:
        with destination.open("wb") as target:
            while chunk := upload.file.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise APIError(413, 41301, "Upload exceeds limit")
                target.write(chunk)
        if total == 0:
            raise APIError(400, 40004, "Upload is empty")
        return total
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        upload.file.close()
