"""
创建测试学生账号，并打印相关信息
"""
import os, sys, json, time, base64, hmac, hashlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from dotenv import load_dotenv

load_dotenv('edu-platform/.env', override=False)
load_dotenv('.env', override=False)

ADMIN_USER_ID = "f886a537-3745-4af2-8802-6ec1af49e052"
ADMIN_USERNAME = "admin"
BASE_URL = os.environ.get('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')

def make_jwt(user_id: str, username: str, role: str = "ADMIN", ttl: int = 3600) -> str:
    secret = os.environ.get("JWT_SECRET", "").strip()
    iss = os.environ.get("JWT_ISS", "edu-platform")
    now = int(time.time())

    def b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    header  = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps(
        {"sub": user_id, "username": username, "role": role,
         "iat": now, "exp": now + ttl, "iss": iss},
        separators=(",", ":"),
    ).encode())
    sig_input = f"{header}.{payload}".encode()
    signature = b64url(hmac.new(secret.encode(), sig_input, hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


import httpx

admin_jwt = make_jwt(ADMIN_USER_ID, ADMIN_USERNAME, "ADMIN")
print(f"Admin JWT: {admin_jwt[:60]}...")

# 创建测试学生
student_data = {
    "studentId": "test_student_001",
    "realName": "测试学生",
    "role": "STUDENT"
}

resp = httpx.post(
    f"{BASE_URL}/api/v1/admin/users",
    json=student_data,
    headers={"Authorization": f"Bearer {admin_jwt}", "Content-Type": "application/json"},
    timeout=30.0
)

print(f"\nPOST /api/v1/admin/users")
print(f"Status: {resp.status_code}")
try:
    body = resp.json()
    print(f"Response: {json.dumps(body, ensure_ascii=False, indent=2)}")
except Exception:
    print(f"Raw: {resp.text[:500]}")
