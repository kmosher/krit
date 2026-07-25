import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Unmount anything rendered by a test so DOM state can't leak between tests.
afterEach(() => cleanup())
