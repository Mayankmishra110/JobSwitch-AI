"""Real embedding tests - no mock. fastembed runs locally (ONNX, no
network once the model is cached), so there is no reason to fake it: a
mocked embedding would prove nothing about whether the model actually
produces sensible vectors, which is the one thing worth testing here.
"""

import numpy as np
from fastapi.testclient import TestClient


def cosine(a: list[float], b: list[float]) -> float:
    va, vb = np.array(a), np.array(b)
    return float(np.dot(va, vb) / (np.linalg.norm(va) * np.linalg.norm(vb)))


def test_healthz_reports_model_loaded(client: TestClient) -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["model_loaded"] is True


def test_embed_returns_correct_shape(client: TestClient) -> None:
    res = client.post("/v1/embed", json={"texts": ["a", "b", "c"], "kind": "job"})
    assert res.status_code == 200
    body = res.json()
    assert body["model"] == "BAAI/bge-small-en-v1.5"
    assert body["dim"] == 384
    assert len(body["vectors"]) == 3
    assert all(len(v) == 384 for v in body["vectors"])


def test_embed_same_text_produces_identical_vector(client: TestClient) -> None:
    res = client.post(
        "/v1/embed",
        json={
            "texts": ["Senior Frontend Engineer", "Senior Frontend Engineer"],
            "kind": "job",
        },
    )
    body = res.json()
    assert body["vectors"][0] == body["vectors"][1]


def test_embed_rejects_empty_texts_list(client: TestClient) -> None:
    res = client.post("/v1/embed", json={"texts": [], "kind": "job"})
    assert res.status_code == 422  # pydantic min_length=1


def test_embed_similarity_regression(client: TestClient) -> None:
    """The genuinely valuable test in this file - a model-swap regression
    guard, named explicitly in the build plan. If BAAI/bge-small-en-v1.5
    is ever swapped for a different model, this is the test that catches
    a swap that produces nonsense embeddings, not just a wrong dimension.
    """
    resume = (
        "Senior Software Engineer with 4 years of experience building "
        "production React and TypeScript applications, Redux Toolkit, "
        "React Query, and Node.js backends."
    )
    matching_jd = (
        "We're looking for a Senior Frontend Engineer skilled in React, "
        "TypeScript and Redux to join our product team."
    )
    unrelated_jd = (
        "We need a Field Veterinarian to provide on-site care for livestock "
        "across rural farms, including surgery and vaccination programs."
    )

    res = client.post(
        "/v1/embed", json={"texts": [resume, matching_jd, unrelated_jd], "kind": "job"}
    )
    vectors = res.json()["vectors"]
    resume_vec, matching_vec, unrelated_vec = vectors

    sim_matching = cosine(resume_vec, matching_vec)
    sim_unrelated = cosine(resume_vec, unrelated_vec)

    assert sim_matching > sim_unrelated, (
        f"expected the resume to be closer to the matching JD ({sim_matching:.4f}) "
        f"than the unrelated one ({sim_unrelated:.4f})"
    )
