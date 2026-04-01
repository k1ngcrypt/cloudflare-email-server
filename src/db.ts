export interface InboxListItem {
  id: number;
  from_address: string;
  from_name: string | null;
  subject: string | null;
  received_at: string;
  read: number;
  starred: number;
  raw_size: number | null;
}

export interface SentListItem {
  id: number;
  to_address: string;
  subject: string | null;
  sent_at: string;
}
