import http from "http";

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot alive");
}).listen(PORT, () => {
  console.log("Keepalive server running on port", PORT);
});
