import * as http from "http";
import { VoxaPlatform } from "./VoxaPlatform";

export function createServer(skill: VoxaPlatform): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404);
      return res.end();
    }

    const chunks: any[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        const reply = await skill.execute(data);
        const json = JSON.stringify(reply);

        res.writeHead(200, {
          "Content-Length": Buffer.byteLength(json),
          "Content-Type": "application/json; charset=utf-8",
        });

        res.end(json);
      } catch (error) {
        console.error(error);
        const json = JSON.stringify(error);

        res.writeHead(500, {
          "Content-Length": Buffer.byteLength(json),
          "Content-Type": "application/json; charset=utf-8",
        });

        res.end(json);
      }
    });
  });
}
