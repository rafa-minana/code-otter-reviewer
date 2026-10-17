import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
  } else if (req.url === "/webhook" || req.url?.startsWith("/admin")) {
    res.writeHead(501).end("not implemented");
  } else {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`api listening on :${port}`));
