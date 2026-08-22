"""Test question 6 to reproduce the 500 error."""
import sys
sys.path.insert(0, ".")
from tests.eval._common import _bootstrap, make_eval_jwt
_bootstrap()
import httpx

jwt = make_eval_jwt()
url = "http://localhost:3000/api/v1/courses/c0000002-0000-4000-8000-000000000000/chat"

q6 = (
    "In which country's old ecclesiastical edifices can the musical instrument "
    "known as the regal still be found?\n\n"
    "Provide a direct and concise answer based strictly on retrieved knowledge. "
    'If the retrieved context is insufficient, respond with "I don\'t know" '
    "--- do not fabricate.\n\n"
    "Use the knowledge retrieval tool to look up relevant information. "
    "Select the retrieval `mode` based on question type:\n"
    "The knowledge tool uses vector retrieval. Write concise, specific search queries."
)

print("Sending question 6...")
try:
    with httpx.stream(
        "POST",
        url,
        json={"message": q6, "trim_history_to": 0, "eval_mode": True},
        headers={"Cookie": f"edu_access={jwt}", "Accept": "text/event-stream"},
        timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0),
    ) as r:
        print(f"Status: {r.status_code}")
        if r.status_code != 200:
            body = r.read().decode("utf-8", errors="replace")[:600]
            print(f"Error body: {body}")
        else:
            for line in r.iter_lines():
                print("LINE:", line[:150])
                if '"type":"done"' in line:
                    break
except Exception as exc:
    print(f"Exception: {exc}")
