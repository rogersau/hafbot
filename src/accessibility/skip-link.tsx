export const MAIN_CONTENT_ID = "main-content";

export function SkipLink() {
  return (
    <a
      className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-3 focus:font-semibold focus:text-primary-foreground focus:outline-2 focus:outline-offset-2 focus:outline-ring"
      href={`#${MAIN_CONTENT_ID}`}
    >
      Skip to main content
    </a>
  );
}
