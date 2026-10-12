import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Pages are lazy chunks (F24): the first visit in a test file imports and transforms the module,
// which can take longer than the 1 s default under parallel load.
configure({ asyncUtilTimeout: 5000 });

// Mantine reads matchMedia and observes element sizes; jsdom has neither.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = vi.fn();

afterEach(() => cleanup());

// Mantine's autosizing Textarea listens for font loading events.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', {
    value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
}
