# Local server for the site, with caching disabled so edits always show up on reload.
# Run from anywhere: python tools/serve.py   ->  http://localhost:5181  (phones on the Wi-Fi: http://<this PC's IP>:5181)
# POST /__log: test devices (phones on the Wi-Fi) report errors and loading progress here (shared/errors.js);
# each report is printed with the device's address, and kept in tools/devlog.txt.
import functools, http.server, pathlib, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOG = pathlib.Path(__file__).resolve().parent / "devlog.txt"

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path != "/__log":
            return self.send_error(404)
        body = self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 20000)).decode("utf-8", "replace")
        line = f"{time.strftime('%H:%M:%S')} {self.client_address[0]} {body}"
        print("DEVLOG " + line, file=sys.stderr, flush=True)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        self.send_response(204)
        self.end_headers()

http.server.ThreadingHTTPServer(("", 5181), functools.partial(NoCache, directory=ROOT)).serve_forever()
