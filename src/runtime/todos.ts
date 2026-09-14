export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export class TodoList {
  private items: TodoItem[] = [];

  replace(items: TodoItem[]): TodoItem[] {
    this.items = items.map((item) => ({ ...item }));
    return this.list();
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }
}
