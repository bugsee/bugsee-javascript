export type IssueStatus = 'open' | 'closed';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface Issue {
  id: string;
  title: string;
  description: string;
  status: IssueStatus;
  severity: IssueSeverity;
  assignee: string;
  labels: string[];
  createdAt: number;
}

export interface Comment {
  id: string;
  issueId: string;
  author: string;
  body: string;
  createdAt: number;
}
