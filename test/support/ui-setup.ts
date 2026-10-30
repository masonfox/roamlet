// The first render in a suite loads and transforms most of the app, which can pass Jest's default 5 s
// on a slow CI machine. A real hang still fails, just later.
jest.setTimeout(30000);
