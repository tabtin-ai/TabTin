import json
def render_shadow(result,format="json"):
    payload=result.as_dict()
    if format=="json": return json.dumps(payload,sort_keys=True,separators=(",",":"))
    if format=="jsonl": return "\n".join(json.dumps({**surface,"package":result.package,"fixture_key":result.fixture_key},sort_keys=True,separators=(",",":")) for surface in payload["surfaces"])
    return "\n".join([f"package={result.package}",f"fixture={result.fixture_key}",f"comparison={result.comparison_hash}",*[f"surface={s['surface']} classification={s['classification']}" for s in payload["surfaces"]]])
