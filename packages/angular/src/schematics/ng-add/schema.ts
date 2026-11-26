/** Options of `ng add @bugsee/angular` (see schema.json). */
export interface Schema {
  /** The application project to set up. Default: the workspace's only application. */
  project?: string;
  /** Your Bugsee app token. Empty or absent: a placeholder is written and you are told to fill it in. */
  appToken?: string;
}
