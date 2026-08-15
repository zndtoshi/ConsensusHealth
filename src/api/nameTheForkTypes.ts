export type NameTheForkVoter = {
  x_user_id: string;
  handle: string | null;
  name: string | null;
  avatar_url: string | null;
  avatar_path: string | null;
};

export type NameTheForkCandidate = {
  id: string;
  display_name: string;
  is_seed: boolean;
  vote_count: number;
  percentage: number;
  rank: number;
  proposer_handle: string | null;
  voters: NameTheForkVoter[];
};

export type NameTheForkMySubmission = {
  id: string;
  display_name: string;
  status: "pending" | "rejected";
  created_at: string;
};

export type NameTheForkPendingSuggestion = {
  id: string;
  display_name: string;
  proposer_handle: string | null;
  created_at: string;
};

export type NameTheForkPayload = {
  generated_at: string;
  title: string;
  subtitle: string;
  total_voters: number;
  candidates: NameTheForkCandidate[];
  me: {
    authenticated: boolean;
    selected_candidate_id: string | null;
    has_custom_slot_used: boolean;
    can_moderate: boolean;
    my_submission: NameTheForkMySubmission | null;
  } | null;
  pending_suggestions: NameTheForkPendingSuggestion[] | null;
};
