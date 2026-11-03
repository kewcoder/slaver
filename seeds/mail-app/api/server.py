#!/usr/bin/env python3
"""Slaver Mail App — backend kecil tanpa dependensi (stdlib saja).

Menghubungkan webmail ke server IMAP/SMTP milik sendiri (lihat ../mail/
atau VPS mana pun): baca folder + pesan via IMAP, kirim via SMTP, simpan
salinan terkirim, tandai sudah dibaca. Satu mailbox usaha (env credentials).

Env:
  PORT, APP_PASSWORD (wajib — kunci buka aplikasi),
  IMAP_HOST, IMAP_PORT=993, IMAP_USER, IMAP_PASS,
  SMTP_HOST, SMTP_PORT=587, SMTP_USER, SMTP_PASS, SMTP_SSL=0/1, MAIL_FROM,
  SLAVER_URL, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET (opsional: "Masuk dengan Slaver").
"""

import base64
import email
import email.header
import email.utils
import hashlib
import hmac
import html
import imaplib
import json
import os
import secrets
import smtplib
import urllib.parse
import urllib.request
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SESSIONS = set()


def env(key, default=""):
    return os.environ.get(key, default).strip()


def need(name, value):
    if not value:
        raise RuntimeError(f"Env {name} belum diisi.")


def imap_open():
    need("IMAP_HOST", env("IMAP_HOST"))
    need("IMAP_USER", env("IMAP_USER"))
    need("IMAP_PASS", env("IMAP_PASS"))
    box = imaplib.IMAP4_SSL(env("IMAP_HOST"), int(env("IMAP_PORT") or "993"))
    box.login(env("IMAP_USER"), env("IMAP_PASS"))
    return box


def decode_header(value):
    if not value:
        return ""
    parts = []
    for text, charset in email.header.decode_header(value):
        if isinstance(text, bytes):
            try:
                parts.append(text.decode(charset or "utf-8", errors="replace"))
            except Exception:
                parts.append(text.decode("utf-8", errors="replace"))
        else:
            parts.append(text)
    return "".join(parts)


def msg_text(msg):
    """Ambil teks polos; lampiran diabaikan (dicatat)."""
    if msg.is_multipart():
        texts, has_files = [], False
        for part in msg.walk():
            disp = (part.get("Content-Disposition") or "").lower()
            ctype = (part.get_content_type() or "").lower()
            if "attachment" in disp:
                has_files = True
                continue
            if ctype == "text/plain" and "attachment" not in disp:
                try:
                    texts.append(part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="replace"))
                except Exception:
                    pass
        body = "\n".join(t for t in texts if t.strip())
        if has_files:
            body += "\n\n[lampiran tidak ditampilkan di versi ini]"
        return body.strip()
    try:
        payload = msg.get_payload(decode=True)
        if payload is None:
            return str(msg.get_payload())
        return payload.decode(msg.get_content_charset() or "utf-8", errors="replace").strip()
    except Exception:
        return ""


def summarize(folder="INBOX", limit=30):
    box = imap_open()
    try:
        box.select(folder, readonly=True)
        _typ, data = box.uid("search", None, "ALL")
        uids = data[0].split() if data and data[0] else []
        uids = uids[-max(1, min(limit, 100)) :]
        out = []
        for uid in reversed(uids):
            typ, fetched = box.uid("fetch", uid, "(FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])")
            if typ != "OK" or not fetched or not fetched[0]:
                continue
            flags = ""
            raw = b""
            for part in fetched:
                if isinstance(part, tuple) and len(part) == 2:
                    if isinstance(part[0], bytes) and b"FLAGS" in part[0]:
                        flags = part[0].decode("utf-8", errors="replace")
                    if isinstance(part[1], bytes):
                        raw = part[1]
            m = email.message_from_bytes(raw)
            out.append({
                "uid": uid.decode("utf-8", errors="replace"),
                "from": decode_header(m.get("From")),
                "to": decode_header(m.get("To")),
                "subject": decode_header(m.get("Subject")) or "(tanpa subjek)",
                "date": m.get("Date", ""),
                "seen": "\\Seen" in flags,
            })
        return out
    finally:
        try:
            box.logout()
        except Exception:
            pass


def read_one(folder, uid):
    box = imap_open()
    try:
        box.select(folder, readonly=True)
        typ, fetched = box.uid("fetch", uid.encode("utf-8", errors="replace"), "(BODY.PEEK[] FLAGS)")
        if typ != "OK" or not fetched or not fetched[0]:
            raise RuntimeError("Pesan tidak ditemukan.")
        raw, flags = b"", ""
        for part in fetched:
            if isinstance(part, tuple) and len(part) == 2:
                if isinstance(part[0], bytes) and b"FLAGS" in part[0]:
                    flags = part[0].decode("utf-8", errors="replace")
                if isinstance(part[1], bytes) and len(part[1]) > 100:
                    raw = part[1]
        m = email.message_from_bytes(raw)
        return {
            "uid": uid,
            "from": decode_header(m.get("From")),
            "to": decode_header(m.get("To")),
            "subject": decode_header(m.get("Subject")) or "(tanpa subjek)",
            "date": m.get("Date", ""),
            "seen": "\\Seen" in flags,
            "body": msg_text(m),
        }
    finally:
        try:
            box.logout()
        except Exception:
            pass


def mark_seen(folder, uid, seen=True):
    box = imap_open()
    try:
        box.select(folder)
        box.uid("store", uid.encode("utf-8", errors="replace"),
                "+FLAGS" if seen else "-FLAGS", "\\Seen")
    finally:
        try:
            box.logout()
        except Exception:
            pass


def send_mail(to, subject, text):
    for name, val in (("SMTP_HOST", env("SMTP_HOST")), ("SMTP_USER", env("SMTP_USER")), ("SMTP_PASS", env("SMTP_PASS"))):
        need(name, val)
    if "@" not in to or "." not in to.split("@")[-1]:
        raise RuntimeError("Alamat tujuan tidak valid.")
    sender = env("MAIL_FROM") or env("SMTP_USER")
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to.strip()
    msg["Subject"] = subject.strip()[:200]
    msg.set_content(text)
    host, port = env("SMTP_HOST"), int(env("SMTP_PORT") or "587")
    if env("SMTP_SSL") == "1":
        smtp = smtplib.SMTP_SSL(host, port, timeout=30)
    else:
        smtp = smtplib.SMTP(host, port, timeout=30)
        try:
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
        except Exception:
            pass  # server lokal tanpa TLS — lanjut plain (jangan di internet!)
    try:
        if env("SMTP_USER"):
            smtp.login(env("SMTP_USER"), env("SMTP_PASS"))
        smtp.send_message(msg)
    finally:
        try:
            smtp.quit()
        except Exception:
            pass
    # Simpan salinan ke folder Terkirim bila ada.
    try:
        box = imap_open()
        try:
            for sent in ("Sent", "INBOX.Sent", "[Gmail]/Sent Mail"):
                try:
                    box.append(sent, "", imaplib.Time2Internaldate(__import__("time").time()), msg.as_bytes())
                    break
                except Exception:
                    continue
        finally:
            try:
                box.logout()
            except Exception:
                pass
    except Exception:
        pass
    return True


def list_folders():
    try:
        box = imap_open()
        try:
            _typ, data = box.list()
            names = []
            for line in data or []:
                try:
                    text = line.decode("utf-8", errors="replace")
                    name = text.split(' "/" ')[-1].strip().strip('"')
                    if name:
                        names.append(name)
                except Exception:
                    continue
            if "INBOX" not in names:
                names.insert(0, "INBOX")
            return names
        finally:
            try:
                box.logout()
            except Exception:
                pass
    except Exception:
        return ["INBOX"]


class Handler(BaseHTTPRequestHandler):
    server_version = "SlaverMail/1.0"

    def _json(self, obj, status=200, cookie=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 1_000_000:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    def _authed(self):
        if not env("APP_PASSWORD"):
            return True  # tanpa kunci, langsung terbuka (tidak disarankan)
        cookie = self.headers.get("Cookie") or ""
        for part in cookie.split(";"):
            part = part.strip()
            if part.startswith("slaver_mail=") and part.split("=", 1)[1] in SESSIONS:
                return True
        return False

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path, qs = url.path, urllib.parse.parse_qs(url.query)
        if path == "/api/health":
            ok = {"imap": bool(env("IMAP_HOST") and env("IMAP_USER")), "smtp": bool(env("SMTP_HOST") and env("SMTP_USER")), "login_required": bool(env("APP_PASSWORD"))}
            return self._json(ok)
        if path == "/api/oauth/config":
            cid = env("OAUTH_CLIENT_ID")
            if not cid:
                return self._json({"enabled": False})
            return self._json({"enabled": True, "client_id": cid, "slaver_url": env("SLAVER_URL", "https://www.slaver.app").rstrip("/")})
        if not self._authed():
            return self._json({"error": "Login dulu."}, status=401)
        try:
            if path == "/api/folders":
                return self._json({"folders": list_folders()})
            if path == "/api/messages":
                folder = (qs.get("folder") or ["INBOX"])[0]
                limit = int((qs.get("limit") or ["30"])[0])
                return self._json({"messages": summarize(folder, limit)})
            if path == "/api/message":
                folder = (qs.get("folder") or ["INBOX"])[0]
                uid = (qs.get("uid") or [""])[0]
                if not uid:
                    return self._json({"error": "uid wajib."}, status=400)
                return self._json(read_one(folder, uid))
        except Exception as e:
            return self._json({"error": str(e)}, status=502)
        return self._json({"error": "Tidak dikenal."}, status=404)

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path
        data = self._body()
        if path == "/api/login":
            want = env("APP_PASSWORD")
            if not want:
                return self._json({"ok": True})
            given = str(data.get("password") or "")
            if hmac.compare_digest(hashlib.sha256(given.encode()).hexdigest(), hashlib.sha256(want.encode()).hexdigest()):
                token = secrets.token_hex(16)
                SESSIONS.add(token)
                return self._json({"ok": True}, cookie=f"slaver_mail={token}; Path=/; HttpOnly; SameSite=Lax")
            return self._json({"error": "Kata sandi salah."}, status=401)
        if path == "/api/logout":
            cookie = self.headers.get("Cookie") or ""
            for part in cookie.split(";"):
                part = part.strip()
                if part.startswith("slaver_mail="):
                    SESSIONS.discard(part.split("=", 1)[1])
            return self._json({"ok": True}, cookie="slaver_mail=; Path=/; Max-Age=0")
        if path == "/api/oauth/exchange":
            # Tukar code -> token via server (client_secret tidak pernah ke browser).
            cid, secret = env("OAUTH_CLIENT_ID"), env("OAUTH_CLIENT_SECRET")
            if not cid or not secret:
                return self._json({"error": "Login Slaver belum dikonfigurasi (lihat OAUTH.md)."}, status=400)
            code = str(data.get("code") or "")
            redirect = str(data.get("redirect_uri") or "")
            if not code:
                return self._json({"error": "code wajib."}, status=400)
            req = urllib.request.Request(
                env("SLAVER_URL", "https://www.slaver.app").rstrip("/") + "/oauth/token",
                data=urllib.parse.urlencode({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect}).encode(),
                headers={"Authorization": "Basic " + base64.b64encode(f"{cid}:{secret}".encode()).decode()},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    tok = json.load(r)
            except Exception as e:
                return self._json({"error": f"Gagal tukar code: {e}"}, status=502)
            access = (tok.get("access_token") or "")
            if not access:
                return self._json({"error": "Token tidak diterima."}, status=502)
            req2 = urllib.request.Request(
                env("SLAVER_URL", "https://www.slaver.app").rstrip("/") + "/oauth/userinfo",
                headers={"Authorization": f"Bearer {access}"},
            )
            try:
                with urllib.request.urlopen(req2, timeout=30) as r2:
                    me = json.load(r2)
            except Exception as e:
                return self._json({"error": f"Gagal ambil profil: {e}"}, status=502)
            token = secrets.token_hex(16)
            SESSIONS.add(token)
            return self._json({"ok": True, "user": me}, cookie=f"slaver_mail={token}; Path=/; HttpOnly; SameSite=Lax")
        if not self._authed():
            return self._json({"error": "Login dulu."}, status=401)
        try:
            if path == "/api/send":
                to = str(data.get("to") or "")
                subject = str(data.get("subject") or "")
                text = str(data.get("text") or "")
                if not to.strip() or not subject.strip() or not text.strip():
                    return self._json({"error": "Tujuan, subjek, dan isi wajib diisi."}, status=400)
                send_mail(to, subject, text)
                return self._json({"ok": True})
            if path == "/api/flag":
                folder = str(data.get("folder") or "INBOX")
                uid = str(data.get("uid") or "")
                if not uid:
                    return self._json({"error": "uid wajib."}, status=400)
                mark_seen(folder, uid, bool(data.get("seen", True)))
                return self._json({"ok": True})
        except Exception as e:
            return self._json({"error": str(e)}, status=502)
        return self._json({"error": "Tidak dikenal."}, status=404)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT") or "8000")
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"slaver-mail api on :{port}", flush=True)
    server.serve_forever()
