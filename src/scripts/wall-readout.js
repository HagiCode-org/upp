// Shows the reading under the pointer or focus in the panel's readout line. Without script every value
// stays in the page: the board, the hidden tables and the text labels carry the same numbers.
for (const scope of document.querySelectorAll('[data-readout-scope]')) {
  const target = scope.querySelector('[data-readout-target]');
  if (!target) {
    continue;
  }
  const original = target.innerHTML;
  const show = (event) => {
    const source = event.target instanceof Element ? event.target.closest('[data-readout]') : null;
    if (source && scope.contains(source)) {
      target.textContent = source.dataset.readout;
      target.dataset.active = 'true';
    }
  };
  const reset = () => {
    target.innerHTML = original;
    delete target.dataset.active;
  };
  scope.addEventListener('pointerover', show);
  scope.addEventListener('pointerleave', reset);
  scope.addEventListener('focusin', show);
  scope.addEventListener('focusout', reset);
  // A tap has no hover, so it reads the value too.
  scope.addEventListener('click', show);

  // The run columns are one tab stop. Arrow keys move along the time axis.
  const stops = [...scope.querySelectorAll('.column .hit')];
  if (stops.length > 1) {
    scope.addEventListener('keydown', (event) => {
      const index = stops.indexOf(document.activeElement);
      if (index === -1) {
        return;
      }
      const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: stops.length - 1 }[event.key];
      if (next === undefined || next < 0 || next >= stops.length) {
        return;
      }
      event.preventDefault();
      stops[index].tabIndex = -1;
      stops[next].tabIndex = 0;
      stops[next].focus();
    });
  }
}
