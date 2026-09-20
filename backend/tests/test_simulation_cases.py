import json

from app.services.simulation_cases import update_status


def test_simulation_ct_is_uploaded_separately_and_access_controlled(
    app_env, people, nifti_file
):
    _, client, settings, _ = app_env
    images_url = f"/api/v1/patients/{people['patient_a_pid']}/medical-images"
    before = client.get(images_url, headers=people["doctor_a"]).json()["data"]["total"]

    with nifti_file.open("rb") as source:
        created = client.post(
            "/api/v1/simulation-cases",
            headers=people["doctor_a"],
            files={"file": ("CT.nii.gz", source, "application/gzip")},
        )
    assert created.status_code == 202, created.text
    payload = created.json()["data"]
    assert payload["source_filename"] == "CT.nii.gz"
    assert payload["status"] == "PENDING"
    assert "owner_user_id" not in payload
    case_id = payload["case_id"]

    status_url = f"/api/v1/simulation-cases/{case_id}"
    owner_view = client.get(status_url, headers=people["doctor_a"])
    assert owner_view.status_code == 200
    # The test environment intentionally has no NV model. This proves that the
    # endpoint fails honestly instead of substituting the teaching manifest.
    assert owner_view.json()["data"]["status"] == "FAILED"
    assert owner_view.json()["data"]["error_code"] == "MODEL_UNAVAILABLE"
    assert client.get(status_url, headers=people["doctor_b"]).status_code == 403
    assert client.get(status_url, headers=people["patient_a"]).status_code == 403
    assert client.get(status_url, headers=people["admin"]).status_code == 200

    after = client.get(images_url, headers=people["doctor_a"]).json()["data"]["total"]
    assert after == before
    case_root = settings.storage_root / "simulation-cases" / case_id
    assert (case_root / "source.nii.gz").is_file()
    assert not list(settings.storage_root.glob(f"medical-images/*{case_id}*"))

    output = case_root / "output"
    (output / "body").mkdir(parents=True)
    manifest = {"schemaVersion": "1.0", "caseId": case_id, "structures": []}
    (output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (output / "body" / "visual.glb").write_bytes(b"glTF-protected-fixture")
    update_status(
        settings,
        case_id,
        status="READY",
        progress=100,
        manifest_url=f"/api/v1/simulation-cases/{case_id}/manifest",
        error_code=None,
        error_message=None,
    )
    manifest_response = client.get(status_url + "/manifest", headers=people["doctor_a"])
    assert manifest_response.status_code == 200
    assert manifest_response.json()["data"]["caseId"] == case_id
    asset_url = status_url + "/assets/body/visual.glb"
    assert client.get(asset_url, headers=people["doctor_a"]).content == b"glTF-protected-fixture"
    assert client.get(asset_url, headers=people["doctor_b"]).status_code == 403


def test_simulation_upload_rejects_non_nifti(app_env, people):
    _, client, _, _ = app_env
    response = client.post(
        "/api/v1/simulation-cases",
        headers=people["doctor_a"],
        files={"file": ("CT.zip", b"not-a-volume", "application/zip")},
    )
    assert response.status_code == 400
    assert response.json()["code"] == 40004
