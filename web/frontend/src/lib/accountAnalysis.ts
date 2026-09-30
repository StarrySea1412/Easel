export interface ArticleEvidence {
  title: string; source: string; period: string; metrics: { label: string; value: number }[];
}
export interface AccountAnalysis {
  status: 'ready' | 'partial' | 'empty' | 'logged_out';
  source: { label: string; url: string };
  fetchedAt: number | null;
  period: string;
  overview: { key: string; label: string; value: number | null }[];
  metrics: { label: string; value: string; comparison: string;
    coverage?: { knownRecords: number | null; sampleRecords: number | null; complete: boolean };
    window?: { kind: string; from: string | null; to: string | null; accountComplete: boolean; aggregation: string; missingDays: number | null };
  }[];
  notes: { title: string; url: string; linkLabel: string; stat: string; publish: string;
    publishedAt?: number | null; hasOriginalLink?: boolean;
    analyticsEvidence?: ArticleEvidence[];
    metrics: { label: string; value: number }[]; missingFields: string[] }[];
  coverage: { notes: number; numericMetrics: number };
  quality?: {
    returnedNotes: number; notesWithMetrics: number; structuredMetricValues: number;
    notesMissingPublishTime: number; notesMissingOriginalLink: number;
    periodKnown: boolean; sampleScope: 'returned_only'; canComparePerformance: boolean;
    level: 'no_content' | 'records_only' | 'metrics_available'; comparisonReason: string;
  };
  periodWindows?: { label: string; from: string | null; to: string | null; observedDays: number | null; missingDays: number | null; complete: boolean }[];
  unmatchedEvidence?: ArticleEvidence[];
  missingFields: string[];
  suggestions: { title: string; reason: string; action: string }[];
  limitations: string[];
}
