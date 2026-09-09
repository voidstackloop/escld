import { Client } from "@elastic/elasticsearch";

export interface PostSearchDocument {
  userId: string;
  text: string;
  tags: string[];
  createdAt: string;
  embedding: number[];
}

export class SearchIndex {
  private readonly client: Client;
  private readonly index: string;

  constructor(url: string, index: string) {
    // Without an explicit ceiling, a stalled connection to Elasticsearch has
    // no built-in timeout and can hang the indexing call indefinitely.
    this.client = new Client({ node: url, requestTimeout: 15_000 });
    this.index = index;
  }

  async indexPost(postId: string, doc: PostSearchDocument): Promise<void> {
    await this.client.index({
      index: this.index,
      id: postId,
      document: doc,
      refresh: false,
    });
  }
}
