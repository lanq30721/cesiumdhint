import argparse
import base64
import binascii
import csv
import getpass
import hmac
import json
import os
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
SOURCE = Path("/Users/Shared/Files From c.localized/coursee/intertextuality")
PAGE = ("唐诗互文可视化.html", "text/html")
GROUPS = {"du": ("李杜", "杜甫"), "meng": ("李白-孟浩然", "孟浩然")}
KEY = os.environ.get("DASHSCOPE_API_KEY", "").strip()
HOST = os.environ.get("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com").rstrip("/")
TEXT_MODEL = os.environ.get("QWEN_TEXT_MODEL", "qwen-plus")
IMAGE_MODEL = os.environ.get("QWEN_IMAGE_MODEL", "qwen-image-3.0")
ASSETS = {"/": PAGE, "/index.html": PAGE, f"/{PAGE[0]}": PAGE,
          "/app.js": ("app.js", "text/javascript"),
          "/style.css": ("style.css", "text/css"), "/cover.png": ("cover.png", "image/png"),
          "/wine-scroll.webp": ("wine-scroll.webp", "image/webp"),
          "/autumn-wind.webp": ("autumn-wind.webp", "image/webp"),
          "/boat-visit.webp": ("boat-visit.webp", "image/webp"),
          "/river-characters.webp": ("river-characters.webp", "image/webp")}


def load(source):
    def read(path):
        with path.open(encoding="utf-8-sig", newline="") as file:
            yield from csv.reader(file)

    poems, groups = {}, {}
    for code, (directory, poet) in GROUPS.items():
        folder = source / directory
        for name in ("李白", poet):
            poems.setdefault(name, defaultdict(dict))
            for title, line, work, index in read(folder / f"{name}.csv"):
                record = (title, line)
                existing = poems[name][work].setdefault(int(index), record)
                if existing != record:
                    raise ValueError(f"诗句编号冲突：{name} / {work} / {index}")

        matches = []
        for a, ta, sa, b, tb, sb, score, h, i, j, k in read(folder / f"李白-{poet}.csv"):
            i, k = int(i), int(k)
            if (a, b) != ("李白", poet) or poems[a][h].get(i) != (ta, sa) or poems[b][j].get(k) != (tb, sb):
                raise ValueError(f"无法查回原诗：{folder} / {h},{i} / {j},{k}")
            matches.append([h, i, j, k, int(score)])
        groups[code] = {"poet": poet, "matches": matches}

    titles = {name: {work: next(iter(lines.values()))[0] for work, lines in works.items()}
              for name, works in poems.items()}
    return poems, {"groups": groups, "titles": titles, "generation": bool(KEY)}


def post_qwen(path, payload):
    req = Request(HOST + path, data=json.dumps(payload).encode(),
                  headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=180) as response:
            result = json.load(response)
    except HTTPError as error:
        try:
            code = json.load(error).get("code", "")
        except (ValueError, AttributeError):
            code = ""
        suffix = f"（{code}）" if isinstance(code, str) and code.replace("_", "").replace(".", "").isalnum() else ""
        raise ValueError(f"百炼返回 HTTP {error.code}{suffix}。请检查对应地域、密钥及模型权限。") from error
    except (URLError, TimeoutError) as error:
        raise ValueError("连接百炼失败或超时，请检查网络后重试。") from error
    if not isinstance(result, dict) or result.get("code"):
        raise ValueError("百炼未完成生成，请核对模型权限、提示词和参考图后重试。")
    return result


def generate(body, poems, groups):
    group = groups[body["group"]]
    match = body["match"]
    if match not in group["matches"]:
        raise ValueError("请选择表中已有的诗句匹配。")
    h, i, j, k, _ = match
    parts = []
    for name, work, index in (("李白", h, i), (group["poet"], j, k)):
        title, target = poems[name][work][index]
        lines = poems[name][work]
        nearby = "".join(lines[n][1] for n in sorted(lines) if abs(n - index) <= 3)
        parts.append(f"{name}《{title}》\n选中诗句：{target}\n原诗近邻：{nearby}")
    idea = body.get("idea", "").strip()
    if not idea or len(idea) > 2000:
        raise ValueError("请输入 1–2000 字的创作灵感。")
    material = "\n\n".join(parts) + "\n\n创作灵感：" + idea

    if body["mode"] == "text":
        result = post_qwen("/compatible-mode/v1/chat/completions", {
            "model": TEXT_MODEL,
            "messages": [
                {"role": "system", "content": "写一段 300 至 600 字的中文历史题材虚构短篇，开头写「虚构二创」。围绕输入的诗句和创作灵感发展一个具体场景。输入诗句是原典素材。人物对白、行动和相会可作虚构处理，避免把创作内容、相似度或未经证实的经历写成史实。"},
                {"role": "user", "content": material},
            ],
            "max_tokens": 1500,
        })
        try:
            output = result["choices"][0]["message"]["content"]
            if isinstance(output, str) and output.strip():
                return {"text": output}
        except (KeyError, IndexError, TypeError):
            pass
        raise ValueError("百炼没有返回可显示的文本。")

    if body["mode"] != "image":
        raise ValueError("请选择文字二创或图像创作。")
    reference = body.get("reference", "")
    content = []
    if reference:
        header, sep, encoded = reference.partition(",")
        if not sep or header not in {"data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"}:
            raise ValueError("参考图需要是 PNG、JPEG 或 WebP。")
        try:
            size = len(base64.b64decode(encoded, validate=True))
        except binascii.Error as error:
            raise ValueError("无法读取参考图。") from error
        if not 0 < size <= 10 * 1024 * 1024:
            raise ValueError("参考图大小需要在 10 MB 以内。")
        content.append({"image": reference})
    instruction = "用参考图借鉴构图、笔触或色调。" if reference else ""
    content.append({"text": f"以唐诗为灵感画一张唐代题材的虚构场景插图。{instruction}把下列诗句意象和创作灵感转成可见场景。避免画出字幕或大段题字。\n{material}"})
    result = post_qwen("/api/v1/services/aigc/multimodal-generation/generation", {
        "model": IMAGE_MODEL,
        "input": {"messages": [{"role": "user", "content": content}]},
        "parameters": {"watermark": True},
    })
    try:
        for item in result["output"]["choices"][0]["message"]["content"]:
            url = item.get("image")
            if isinstance(url, str) and urlsplit(url).scheme == "https":
                return {"image": url}
    except (KeyError, IndexError, TypeError, AttributeError):
        pass
    raise ValueError("百炼没有返回可显示的图片链接。")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_content(self, data, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type if content_type.startswith("image/") else f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, data, status=200):
        self.send_content(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode(), "application/json", status)

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        if path in ASSETS:
            file, mime = ASSETS[path]
            self.send_content((HERE / file).read_bytes(), mime)
        elif parsed.path == "/api/data":
            self.send_content(self.server.dataset_json, "application/json")
        elif parsed.path == "/api/poem":
            args = parse_qs(parsed.query)
            name = args.get("poet", [""])[0]
            work = args.get("id", [""])[0]
            lines = self.server.poems.get(name, {}).get(work)
            if lines:
                self.send_json([[index, lines[index][1]] for index in sorted(lines)])
            else:
                self.send_json({"error": "没有查到原诗。"}, 404)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != "/api/generate":
            self.send_error(404)
            return
        try:
            if self.headers.get_content_type() != "application/json":
                self.reject_generation("请从可视化页面提交生成请求。", 403)
                return
            cloud = self.server.cloud
            if not cloud:
                origin = self.headers.get("Origin")
                expected = f"http://127.0.0.1:{self.server.server_port}"
                if origin and origin != expected:
                    self.reject_generation("请从本地页面提交生成请求。", 403)
                    return
            if not self.server.dataset["generation"]:
                self.reject_generation("此站点尚未启用二创生成。", 503)
                return
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 15 * 1024 * 1024:
                self.reject_generation("请求大小超出限制。", 400)
                return
            body = json.loads(self.rfile.read(size))
        except ValueError as error:
            self.reject_generation(str(error), 400)
            return
        if cloud:
            entered = body.pop("passcode", "") if isinstance(body, dict) else ""
            if not isinstance(entered, str) or not hmac.compare_digest(entered.encode(), self.server.passcode):
                self.send_json({"error": "二创口令不正确。"}, 403)
                return
            self.stream_generation(body)
            return
        result = self.generation_result(body)
        self.send_json(result, 400 if "error" in result else 200)

    def reject_generation(self, message, status):
        # The request body may be unread, so this connection cannot be reused.
        self.close_connection = True
        self.send_json({"error": message}, status)

    def generation_result(self, body):
        try:
            return generate(body, self.server.poems, self.server.dataset["groups"])
        except (KeyError, TypeError, AttributeError):
            return {"error": "生成参数不完整，请重新选择诗句与创作方式。"}
        except ValueError as error:
            return {"error": str(error)}

    def stream_generation(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def send_event(event):
            data = event.encode("utf-8")
            self.wfile.write(f"{len(data):X}\r\n".encode("ascii") + data + b"\r\n")
            self.wfile.flush()

        with ThreadPoolExecutor(max_workers=1) as pool:
            try:
                send_event(": processing\n\n")
                future = pool.submit(self.generation_result, body)
                while True:
                    try:
                        result = future.result(timeout=10)
                    except TimeoutError:
                        send_event(": processing\n\n")
                    else:
                        send_event("data: " + json.dumps(result, ensure_ascii=False) + "\n\n")
                        self.wfile.write(b"0\r\n\r\n")
                        break
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="唐诗互文可视化")
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--port", type=int)
    parser.add_argument("--cloud", action="store_true", help="以容器模式监听，并使用二创口令")
    parser.add_argument("--prompt-key", action="store_true", help="在终端中隐式输入百炼密钥")
    args = parser.parse_args()
    if args.prompt_key:
        KEY = getpass.getpass("百炼 API Key：").strip()
    passcode = os.environ.get("TANG_GENERATION_PASSCODE", "").strip().encode() if args.cloud else b""
    poems, dataset = load(args.source)
    if args.cloud:
        dataset["generation"] = bool(KEY and passcode)
        dataset["requiresPasscode"] = dataset["generation"]
    default_port = int(os.environ.get("PORT", "8080")) if args.cloud else 8765
    port = args.port if args.port is not None else default_port
    host = "0.0.0.0" if args.cloud else "127.0.0.1"
    with ThreadingHTTPServer((host, port), Handler) as server:
        server.cloud, server.passcode = args.cloud, passcode
        server.poems, server.dataset = poems, dataset
        server.dataset_json = json.dumps(dataset, ensure_ascii=False, separators=(",", ":")).encode()
        print(f"唐诗互文可视化 http://{host}:{server.server_port}  |  Qwen：{'已启用' if dataset['generation'] else '待配置'}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
