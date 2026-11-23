import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('creates the application shell', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect(fixture.componentInstance).toBeTruthy();
    expect(fixture.componentInstance.showShell()).toBe(false);
  });
});
