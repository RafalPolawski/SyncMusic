import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom does not implement scrolling.
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
  localStorage.clear();
});
