import { lazy, Suspense, type ComponentType } from "react";

type PageProps = Record<string, unknown>;
type PageModule = Record<string, unknown>;
type TestPageLoader = (exportName: string) => ComponentType<PageProps> | undefined;

export type LazyAdminPageComponent = ComponentType<PageProps> & {
  preload: () => Promise<void>;
};

let testPageLoader: TestPageLoader | undefined;

export function setAdminPageTestLoader(loader: TestPageLoader | undefined) {
  if (process.env.NODE_ENV === "production") return;
  testPageLoader = loader;
}

export function createLazyAdminPage(load: () => Promise<PageModule>, exportName: string) {
  let modulePromise: Promise<PageModule> | undefined;
  const loadModule = () => (modulePromise ??= load());
  const LazyPage = lazy(async () => ({
    default: (await loadModule())[exportName] as ComponentType<PageProps>,
  }));

  const AdminPage = function AdminPage(props: PageProps) {
    if (process.env.NODE_ENV !== "production") {
      const TestPage = testPageLoader?.(exportName);
      if (TestPage) return <TestPage {...props} />;
    }

    return (
      <Suspense fallback={<AdminPageLoadingFallback />}>
        <LazyPage {...props} />
      </Suspense>
    );
  } satisfies ComponentType<PageProps>;

  return Object.assign(AdminPage, {
    preload: async () => {
      await loadModule();
    },
  }) satisfies LazyAdminPageComponent;
}

export function AdminPageLoadingFallback() {
  return (
    <div
      className="flex min-h-48 items-center justify-center rounded-lg border border-border bg-muted/20 px-6 text-sm text-muted-foreground"
      role="status"
      aria-label="Loading page"
      aria-live="polite"
    >
      Loading page...
    </div>
  );
}
