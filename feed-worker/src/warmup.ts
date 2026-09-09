import { warmUpEmbeddings } from "./embeddings.js";

await warmUpEmbeddings();
console.log("Embedding model cached.");
