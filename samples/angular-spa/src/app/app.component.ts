import { Component, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { isManager, setManager } from './core/manager-state';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  readonly manager = signal(isManager());

  toggleManager(): void {
    const next = !this.manager();
    setManager(next);
    this.manager.set(next);
  }
}
