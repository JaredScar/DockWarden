import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Config as DOMPurifyConfig } from 'dompurify';

// Configure marked once: GitHub Flavored Markdown, soft line breaks.
const renderer = new marked.Renderer();

// Force external links to open in a new tab with noopener.
renderer.link = ({ href, title, text }: { href: string; title?: string | null; text: string }) => {
  const safeHref = /^https?:\/\//i.test(href ?? '') ? href : '#';
  const t = title ? ` title="${title}"` : '';
  return `<a href="${safeHref}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

marked.setOptions({ renderer, gfm: true, breaks: true });

// Allowlist for DOMPurify — everything needed for standard Markdown output.
const PURIFY_CONFIG: DOMPurifyConfig = {
  ALLOWED_TAGS: [
    'h1','h2','h3','h4','h5','h6',
    'p','br','hr','strong','b','em','i','del','s','u',
    'ul','ol','li',
    'blockquote',
    'pre','code',
    'a',
    'table','thead','tbody','tr','th','td',
    'details','summary',
  ],
  ALLOWED_ATTR: ['href','alt','title','class','rel','target'],
  ALLOW_DATA_ATTR: false,
  FORCE_BODY: true,
};

@Pipe({ name: 'markdown', standalone: true, pure: true })
export class MarkdownPipe implements PipeTransform {
  private readonly domSanitizer = inject(DomSanitizer);

  transform(value: string | null | undefined): SafeHtml {
    if (!value?.trim()) return '';
    const rawHtml  = marked.parse(value) as string;
    const safeHtml = String(DOMPurify.sanitize(rawHtml, PURIFY_CONFIG));
    // Angular's DomSanitizer would strip valid Markdown HTML (tables, blockquotes);
    // DOMPurify has already removed all XSS vectors so bypassing is safe here.
    return this.domSanitizer.bypassSecurityTrustHtml(safeHtml);
  }
}
