import { MOCK_TRACKING_TOKEN } from './seed';
import { resetCreatedReportSequence } from './store';
import { resetTrackedTokens } from './tracking';

export { MOCK_TRACKING_TOKEN, resetCreatedReportSequence };

/** Compatibility shim for the old fixture API. */
export function resetTrackedReports(): void {
  resetTrackedTokens();
}