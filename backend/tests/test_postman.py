"""Коллекция Postman покрывает все эндпоинты API и совпадает с закоммиченной версией."""

from __future__ import annotations

import json

from cqa import postman
from cqa.app import app


def test_collection_covers_every_route():
    data = postman.build(app)
    folders = {f["name"] for f in data["item"]}
    assert "Прочее" not in folders, "новый эндпоинт не попал ни в один раздел - добавьте правило в FOLDERS"
    got = {(i["request"]["method"], "/" + "/".join(i["request"]["url"]["path"])) for f in data["item"] for i in f["item"]}
    expected = {(m, postman.re.sub(r"\{(\w+)\}", lambda x: "{{" + postman.PATH_VARS.get(x.group(1), x.group(1)) + "}}", p))
                for m, p in postman.api_routes(app)}
    assert got == expected
    missing_titles = [r for r in postman.api_routes(app) if r not in postman.TITLES]
    assert not missing_titles, f"нет названия для {missing_titles}"
    for f in data["item"]:
        for i in f["item"]:
            if i["request"]["method"] in ("POST", "PUT"):
                json.loads(i["request"]["body"]["raw"])  # тело - валидный JSON


def test_committed_collection_is_up_to_date():
    committed = json.loads(postman.OUT.read_text(encoding="utf-8"))
    assert committed == json.loads(json.dumps(postman.build(app), ensure_ascii=False)), \
        "docs/CQA.postman_collection.json устарела: выполните cd backend && python -m cqa.postman"
