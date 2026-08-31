import { Component, Input, OnInit } from '@angular/core';

// §5.6 "beyond the catalog" fixture: an error thrown IN A COMPONENT (`ngOnInit`, so it fires during
// Angular's own change-detection/lifecycle-hook cycle, inside the zone) — as opposed to a service method
// or an RxJS pipeline (see `throwing.service.ts`). Mounted conditionally (`@if (armed)`) from the
// Scenario panel so arming it is a deliberate user action.
@Component({
  selector: 'app-throwing-widget',
  standalone: true,
  template: `<p data-testid="throwing-widget">rendered — should have thrown in ngOnInit</p>`,
})
export class ThrowingWidgetComponent implements OnInit {
  @Input() label = 'widget';

  ngOnInit(): void {
    throw new Error(`ThrowingWidgetComponent (${this.label}): thrown from ngOnInit`);
  }
}
