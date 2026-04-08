import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import markdownToHtml from "zenn-markdown-html";
// @ts-expect-error zenn-content-css has no type declarations
import "zenn-content-css";
import { codeToHtml } from "shiki";
import { fetchFileContent, openRelativeFile } from "../hooks/useApi";
import { escapeRegExp } from "../utils/regex";
import { RawToggle } from "./RawToggle";
import { TocToggle } from "./TocToggle";
import { CopyButton } from "./CopyButton";
import { CloseFileButton } from "./CloseFileButton";
import { resolveLink, resolveImageSrc } from "../utils/resolve";
import { parseFrontmatter } from "../utils/frontmatter";
import { stripMdxSyntax } from "../utils/mdx";
import { isMarkdownFile, detectLanguage } from "../utils/filetype";
import type { ZoomContent } from "./ZoomModal";
import type { TocHeading } from "./TocPanel";

interface MarkdownViewerProps {
  fileId: string;
  fileName: string;
  revision: number;
  onFileOpened: (fileId: string) => void;
  onHeadingsChange: (headings: TocHeading[]) => void;
  onContentRendered?: () => void;
  isTocOpen: boolean;
  onTocToggle: () => void;
  onRemoveFile: () => void;
  uploaded?: boolean;
  isWide: boolean;
  onZoom?: (content: ZoomContent) => void;
  scrollToHeading?: string | null;
  onScrolledToHeading?: () => void;
  searchQuery?: string | null;
}

interface SearchHitMarker {
  top: number;
  height: number;
}

const SEARCH_HIT_COLUMN_OFFSET = -24;

function collectSearchHitMarkers(root: HTMLElement, query: string): SearchHitMarker[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const pattern = new RegExp(escapeRegExp(trimmed), "gi");
  const articleRect = root.getBoundingClientRect();
  const markers = new Map<string, SearchHitMarker>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        parent == null ||
        parent.closest("script, style, .frontmatter-block") != null ||
        node.textContent == null ||
        node.textContent.trim() === ""
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      pattern.lastIndex = 0;
      return pattern.test(node.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let current = walker.nextNode();
  while (current != null) {
    if (current instanceof Text) {
      const text = current.textContent ?? "";
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        const range = document.createRange();
        range.setStart(current, start);
        range.setEnd(current, end);
        const [rect] = Array.from(range.getClientRects());
        if (rect != null && rect.height > 0 && rect.width > 0) {
          const top = rect.top - articleRect.top;
          const height = rect.height;
          const key = `${Math.round(top)}:${Math.round(height)}`;
          markers.set(key, {
            top,
            height,
          });
        }
      }
    }
    current = walker.nextNode();
  }

  return [...markers.values()].sort((a, b) => a.top - b.top);
}

function HighlightedView({ content, language }: { content: string; language: string }) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let cancelled = false;
    setHtml("");
    codeToHtml(content, { lang: language, theme: "github-dark" })
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) {
          codeToHtml(content, { lang: "text", theme: "github-dark" })
            .then((result) => {
              if (!cancelled) setHtml(result);
            })
            .catch(() => {});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [content, language]);

  if (html) {
    return <div className="[&_pre]:!rounded-none" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <pre>
      <code>{content}</code>
    </pre>
  );
}

function RawView({ content }: { content: string }) {
  return <HighlightedView content={content} language="markdown" />;
}

// Stub: MermaidBlock was used with react-markdown but is no longer needed with zenn-markdown-html.
// Kept as export for test compatibility.
export function MermaidBlock({ code }: { code: string; onZoom?: (content: ZoomContent) => void }) {
  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}

// Load zenn-embed-elements once for KaTeX rendering
let embedLoaded = false;
function loadZennEmbedElements() {
  if (embedLoaded) return;
  embedLoaded = true;
  import("zenn-embed-elements").catch(() => {
    embedLoaded = false;
  });
}

// Rewrite relative image src attributes in an HTML string before mounting
function rewriteImageSrcs(html: string, fileId: string): string {
  return html.replace(
    /(<img\s[^>]*?\bsrc=")([^"]+)(")/g,
    (_match, prefix: string, src: string, suffix: string) => {
      const resolved = resolveImageSrc(src, fileId);
      return resolved && resolved !== src ? `${prefix}${resolved}${suffix}` : _match;
    },
  );
}

export function MarkdownViewer({
  fileId,
  fileName,
  revision,
  onFileOpened,
  onHeadingsChange,
  onContentRendered,
  isTocOpen,
  onTocToggle,
  onRemoveFile,
  uploaded,
  isWide,
  onZoom: _,
  scrollToHeading,
  onScrolledToHeading,
  searchQuery,
}: MarkdownViewerProps) {
  const [content, setContent] = useState("");
  const [renderedHtml, setRenderedHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [isRawView, setIsRawView] = useState(false);
  const [searchHitMarkers, setSearchHitMarkers] = useState<SearchHitMarker[]>([]);
  const articleRef = useRef<HTMLElement>(null);
  const [prevFetchKey, setPrevFetchKey] = useState({ fileId, revision });

  if (fileId !== prevFetchKey.fileId || revision !== prevFetchKey.revision) {
    setPrevFetchKey({ fileId, revision });
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    fetchFileContent(fileId)
      .then((data) => {
        if (!cancelled) {
          setContent(data.content);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContent("Failed to load file.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, revision]);

  const isMarkdown = isMarkdownFile(fileName);
  const codeLanguage = isMarkdown ? null : detectLanguage(fileName);

  const parsed = useMemo(
    () => (isMarkdown && !isRawView ? parseFrontmatter(content) : null),
    [content, isRawView, isMarkdown],
  );

  // Convert markdown to HTML using zenn-markdown-html
  useEffect(() => {
    if (!isMarkdown || isRawView) {
      setRenderedHtml("");
      return;
    }

    let cancelled = false;
    // Clear stale HTML immediately to avoid flash of old content
    setRenderedHtml("");

    const base = parsed ? parsed.content : content;
    const md = fileName.toLowerCase().endsWith(".mdx") ? stripMdxSyntax(base) : base;

    markdownToHtml(md, { embedOrigin: "https://embed.zenn.studio" })
      .then((html) => {
        if (!cancelled) {
          // Rewrite image paths before mounting to avoid double fetch
          setRenderedHtml(rewriteImageSrcs(html, fileId));
          loadZennEmbedElements();
        }
      })
      .catch(() => {
        if (!cancelled) setRenderedHtml("<p>Failed to render markdown.</p>");
      });

    return () => {
      cancelled = true;
    };
  }, [content, isRawView, isMarkdown, parsed, fileName, fileId]);

  // Handle link clicks via event delegation using the shared resolver
  useEffect(() => {
    const article = articleRef.current;
    if (!article || !isMarkdown || isRawView) return;

    const handleClick = async (e: MouseEvent) => {
      // Ignore modified clicks (middle-click, ctrl-click, etc.)
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const anchor = (e.target as HTMLElement).closest("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href) return;

      const resolved = resolveLink(href, fileId);
      switch (resolved.type) {
        case "external":
          // Let browser handle (opens in new tab via target if set by zenn-markdown-html)
          return;
        case "hash": {
          e.preventDefault();
          const id = href.slice(1);
          const target = document.getElementById(id);
          if (target) {
            const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
            history.pushState(null, "", href);
          }
          return;
        }
        case "markdown": {
          e.preventDefault();
          try {
            const entry = await openRelativeFile(fileId, resolved.hrefPath);
            onFileOpened(entry.id);
          } catch {
            // fallback: do nothing
          }
          return;
        }
        case "file": {
          e.preventDefault();
          window.open(resolved.rawUrl, "_blank");
          return;
        }
        case "passthrough":
          return;
      }
    };

    article.addEventListener("click", handleClick);
    return () => article.removeEventListener("click", handleClick);
  }, [renderedHtml, fileId, isMarkdown, isRawView, onFileOpened]);

  const renderedContent = useMemo(() => {
    if (!isMarkdown) {
      return <HighlightedView content={content} language={codeLanguage!} />;
    }
    if (isRawView) {
      return <RawView content={content} />;
    }
    return <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />;
  }, [content, isRawView, isMarkdown, codeLanguage, renderedHtml]);

  const prevHeadingsKey = useRef("");
  useEffect(() => {
    const newHeadings: TocHeading[] = [];
    if (!isRawView && articleRef.current) {
      const els = articleRef.current.querySelectorAll("h1, h2, h3, h4, h5, h6");
      for (const el of els) {
        if (el.id) {
          newHeadings.push({
            id: el.id,
            text: el.textContent ?? "",
            level: parseInt(el.tagName.slice(1), 10),
          });
        }
      }
    }
    const key = newHeadings.map((h) => `${h.id}:${h.level}:${h.text}`).join(",");
    if (key !== prevHeadingsKey.current) {
      prevHeadingsKey.current = key;
      onHeadingsChange(newHeadings);
    }
  }, [isRawView, renderedContent, onHeadingsChange]);

  const onContentRenderedRef = useRef(onContentRendered);
  useLayoutEffect(() => {
    onContentRenderedRef.current = onContentRendered;
  });

  // Fire onContentRendered after content is visible:
  // - For markdown: after async markdownToHtml completes (renderedHtml is set)
  // - For non-markdown / raw view: immediately after content loads (renderedHtml stays empty)
  useLayoutEffect(() => {
    if (!loading && (renderedHtml || !isMarkdown || isRawView)) {
      onContentRenderedRef.current?.();
    }
  }, [loading, renderedHtml, isMarkdown, isRawView]);

  useLayoutEffect(() => {
    if (loading || !scrollToHeading || !articleRef.current) {
      return;
    }

    const headings = articleRef.current.querySelectorAll("h1, h2, h3, h4, h5, h6");
    const target = Array.from(headings).find(
      (el) => (el.textContent ?? "").trim() === scrollToHeading,
    );
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      onScrolledToHeading?.();
    }
  }, [loading, renderedContent, scrollToHeading, onScrolledToHeading]);

  useLayoutEffect(() => {
    if (loading || !articleRef.current || !isMarkdown || isRawView || !searchQuery?.trim()) {
      setSearchHitMarkers([]);
      return;
    }

    const updateMarkers = () => {
      if (!articleRef.current) {
        return;
      }
      setSearchHitMarkers(collectSearchHitMarkers(articleRef.current, searchQuery));
    };

    updateMarkers();

    const resizeObserver = new ResizeObserver(() => updateMarkers());
    resizeObserver.observe(articleRef.current);
    for (const element of articleRef.current.querySelectorAll("img, svg")) {
      resizeObserver.observe(element);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [loading, renderedContent, isMarkdown, isRawView, searchQuery]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-50 text-gh-text-secondary text-sm">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <article
        ref={articleRef}
        className={`znc relative min-w-0 flex-1 overflow-visible${isWide ? " znc--wide" : ""}`}
      >
        <div className="pointer-events-none absolute inset-0 z-10 overflow-visible">
          {searchHitMarkers.map((marker, index) => (
            <div
              key={`${marker.top}:${marker.height}:${index}`}
              className="absolute w-1 rounded-none bg-gh-text/80"
              style={{
                left: SEARCH_HIT_COLUMN_OFFSET,
                top: marker.top,
                height: marker.height,
              }}
            />
          ))}
        </div>
        {renderedContent}
      </article>
      <div className="shrink-0 flex flex-col gap-2 -mr-4 -mt-4">
        {isMarkdown && <TocToggle isTocOpen={isTocOpen} onToggle={onTocToggle} />}
        {isMarkdown && <RawToggle isRaw={isRawView} onToggle={() => setIsRawView((v) => !v)} />}
        <CopyButton content={content} />
        <CloseFileButton onClose={onRemoveFile} uploaded={uploaded} />
      </div>
    </div>
  );
}
