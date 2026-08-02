import wasm from "../target/step1-wasm-node/neoseq_core.js";

const relay = process.argv[2] ?? "ws://127.0.0.1:39091";

const peer = new wasm.SpikePeer(3n);
peer.edit("wasm-a|");
const first = peer.export_all();
peer.edit("wasm-b|");
const second = peer.export_all();

const socket = new WebSocket(relay);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error(`connect Wasm peer to ${relay}`)), {
    once: true,
  });
});

socket.binaryType = "arraybuffer";
socket.send(second);
socket.send(first);
socket.addEventListener("message", (event) => {
  peer.import(new Uint8Array(event.data));
});

await new Promise((resolve) => setTimeout(resolve, 3000));
socket.close();
process.stdout.write(
  `${JSON.stringify({ peer: "wasm", fixture_hash: peer.hash(), status: "passed" })}\n`,
);
