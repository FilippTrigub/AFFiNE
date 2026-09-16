import { Injectable } from '@nestjs/common';

import type { DocChunkSimilarity } from '../../models';
import type { DocumentVectorSearch } from '../retrieval';

/**
 * Vector-search stub for the MCP module.
 *
 * `DocumentRetrievalService` runs lexical and vector retrieval in parallel and
 * consults `canEmbedding` before touching the vector side. Binding
 * DOCUMENT_VECTOR_SEARCH to this implementation keeps the embedding stack — and
 * therefore any AI provider credential — out of the MCP dependency graph
 * entirely: `doc_search` reports `retrieval_mode: "lexical"` with
 * `degraded_reason: "VECTOR_UNAVAILABLE"`.
 */
@Injectable()
export class NullDocumentVectorSearch implements DocumentVectorSearch {
  readonly canEmbedding = false;

  async matchWorkspaceDocCandidates(): Promise<DocChunkSimilarity[]> {
    return [];
  }

  async rerankWorkspaceDocs(): Promise<DocChunkSimilarity[]> {
    return [];
  }
}
