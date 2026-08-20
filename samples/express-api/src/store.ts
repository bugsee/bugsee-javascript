// A tiny file-backed JSON store for the Task API. Not a real database — a real one would be overkill
// for a sample whose job is to exercise @bugsee/express, but the persistence is real: restart the
// server and your projects/tasks are still there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  done: boolean;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

interface Db {
  projects: Project[];
  tasks: Task[];
}

const EMPTY_DB: Db = { projects: [], tasks: [] };

export class JsonFileStore {
  private db: Db;

  constructor(private readonly path: string) {
    this.db = this.load();
  }

  private load(): Db {
    if (!existsSync(this.path)) return { projects: [], tasks: [] };
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Db>;
      return { projects: parsed.projects ?? [], tasks: parsed.tasks ?? [] };
    } catch {
      // A corrupt store file must not take the whole API down at boot.
      return { ...EMPTY_DB };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.db, null, 2));
  }

  // --- Projects ---

  listProjects(): Project[] {
    return this.db.projects;
  }

  getProject(id: string): Project | undefined {
    return this.db.projects.find((p) => p.id === id);
  }

  createProject(name: string): Project {
    const project: Project = { id: randomShortId(), name, createdAt: new Date().toISOString() };
    this.db.projects.push(project);
    this.save();
    return project;
  }

  updateProject(id: string, patch: Partial<Pick<Project, 'name'>>): Project | undefined {
    const project = this.getProject(id);
    if (project === undefined) return undefined;
    if (patch.name !== undefined) project.name = patch.name;
    this.save();
    return project;
  }

  deleteProject(id: string): boolean {
    const before = this.db.projects.length;
    this.db.projects = this.db.projects.filter((p) => p.id !== id);
    this.db.tasks = this.db.tasks.filter((t) => t.projectId !== id);
    this.save();
    return this.db.projects.length < before;
  }

  // --- Tasks ---

  listTasks(projectId: string): Task[] {
    return this.db.tasks.filter((t) => t.projectId === projectId);
  }

  getTask(projectId: string, taskId: string): Task | undefined {
    return this.db.tasks.find((t) => t.projectId === projectId && t.id === taskId);
  }

  createTask(projectId: string, title: string): Task {
    const task: Task = {
      id: randomShortId(),
      projectId,
      title,
      done: false,
      createdAt: new Date().toISOString(),
    };
    this.db.tasks.push(task);
    this.save();
    return task;
  }

  updateTask(
    projectId: string,
    taskId: string,
    patch: Partial<Pick<Task, 'title' | 'done'>>,
  ): Task | undefined {
    const task = this.getTask(projectId, taskId);
    if (task === undefined) return undefined;
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.done !== undefined) task.done = patch.done;
    this.save();
    return task;
  }

  deleteTask(projectId: string, taskId: string): boolean {
    const before = this.db.tasks.length;
    this.db.tasks = this.db.tasks.filter((t) => !(t.projectId === projectId && t.id === taskId));
    this.save();
    return this.db.tasks.length < before;
  }
}

function randomShortId(): string {
  return Math.random().toString(36).slice(2, 10);
}
