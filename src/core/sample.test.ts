describe('core test project', () => {
  it('runs in plain Node with TypeScript support', () => {
    const runtime: string = process.release.name;
    expect(runtime).toBe('node');
    expect(typeof window).toBe('undefined');
  });
});
