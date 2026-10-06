import {
  docTranslationsQuery,
  refreshDocTranslationsMutation,
  setDocTranslationsMutation,
} from '@affine/graphql';
import { Store } from '@toeverything/infra';

import type { WorkspaceServerService } from '../../cloud';

export class DocTranslationsStore extends Store {
  constructor(private readonly workspaceServerService: WorkspaceServerService) {
    super();
  }

  private get server() {
    const server = this.workspaceServerService.server;
    if (!server) {
      throw new Error('No Server');
    }
    return server;
  }

  async list(workspaceId: string, docId: string, signal?: AbortSignal) {
    const data = await this.server.gql({
      query: docTranslationsQuery,
      variables: { workspaceId, docId },
      context: { signal },
    });
    return data.docTranslations;
  }

  async set(
    workspaceId: string,
    docId: string,
    sourceLang: string,
    languages: string[]
  ) {
    const data = await this.server.gql({
      query: setDocTranslationsMutation,
      variables: { workspaceId, docId, sourceLang, languages },
    });
    return data.setDocTranslations;
  }

  async refresh(workspaceId: string, docId: string) {
    const data = await this.server.gql({
      query: refreshDocTranslationsMutation,
      variables: { workspaceId, docId },
    });
    return data.refreshDocTranslations;
  }
}
