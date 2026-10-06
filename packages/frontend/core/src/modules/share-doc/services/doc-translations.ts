import type { DocTranslationsQuery } from '@affine/graphql';
import { LiveData, Service } from '@toeverything/infra';

import type { DocService } from '../../doc';
import type { WorkspaceService } from '../../workspace';
import type { DocTranslationsStore } from '../stores/doc-translations';

export type DocTranslation = DocTranslationsQuery['docTranslations'][number];

/** Published machine translations of the current doc. */
export class DocTranslationsService extends Service {
  private revalidationId = 0;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly docService: DocService,
    private readonly store: DocTranslationsStore
  ) {
    super();
  }

  translations$ = new LiveData<DocTranslation[]>([]);
  /** False when the server has translation turned off. */
  available$ = new LiveData(false);
  inProgress$ = this.translations$.map(rows =>
    rows.some(row => row.status === 'pending' || row.status === 'running')
  );

  private get ids() {
    return [
      this.workspaceService.workspace.id,
      this.docService.doc.id,
    ] as const;
  }

  async revalidate() {
    const revalidationId = ++this.revalidationId;
    try {
      const rows = await this.store.list(...this.ids);
      if (revalidationId !== this.revalidationId) return;
      this.translations$.value = rows;
      this.available$.value = true;
    } catch {
      if (revalidationId !== this.revalidationId) return;
      // The query is guarded by translate.enabled; any refusal hides the UI.
      this.translations$.value = [];
      this.available$.value = false;
    }
  }

  async setLanguages(sourceLang: string, languages: string[]) {
    this.revalidationId++;
    this.translations$.value = await this.store.set(
      ...this.ids,
      sourceLang,
      languages
    );
  }

  async refresh() {
    this.revalidationId++;
    this.translations$.value = await this.store.refresh(...this.ids);
  }
}
