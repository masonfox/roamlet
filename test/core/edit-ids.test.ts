import {
  checkIdChanges,
  editableBody,
  editableTitle,
  scan,
  spliceBody,
  spliceTitle,
} from '../../src/core/org';

// Scenarios from openspec/changes/add-roamlet-mvp/specs/note-capture-editing/spec.md.
const headingWith = (title: string, id: string) =>
  `* ${title}\n:PROPERTIES:\n:ID: ${id}\n:END:\nText\n`;
const fileWith = (id: string, title = 'File') =>
  `:PROPERTIES:\n:ID: ${id}\n:END:\n#+title: ${title}\n`;

function check(before: string, after: string, others?: ReadonlySet<string>) {
  return checkIdChanges(scan(before), scan(after), others);
}

describe('ID protection during editing', () => {
  it('Heading ID removed', () => {
    const text = `${fileWith('file')}${headingWith('One', 'one')}`;
    const doc = scan(text);
    const body = editableBody(text, doc).replace(':ID: one\n', '');
    const after = spliceBody(text, doc, body).text;
    expect(checkIdChanges(doc, scan(after))).toEqual([
      { kind: 'removed', id: 'one', level: 1, title: 'One' },
    ]);
  });

  it('warns when a whole heading node is deleted', () => {
    expect(check(`${fileWith('file')}${headingWith('One', 'one')}`, fileWith('file'))).toEqual([
      { kind: 'removed', id: 'one', level: 1, title: 'One' },
    ]);
  });

  it('warns when the file-level ID is removed', () => {
    expect(check(fileWith('file'), '#+title: File\n')).toEqual([
      { kind: 'removed', id: 'file', level: 0, title: 'File' },
    ]);
  });

  it('warns when an edit excludes a node', () => {
    const before = headingWith('One', 'one');
    const after = '* One\n:PROPERTIES:\n:ID: one\n:ROAM_EXCLUDE: t\n:END:\nText\n';
    expect(check(before, after)).toEqual([{ kind: 'removed', id: 'one', level: 1, title: 'One' }]);
  });

  it('warns when a heading ID is changed', () => {
    expect(check(headingWith('One', 'one'), headingWith('One', 'two'))).toEqual([
      { kind: 'changed', id: 'one', newId: 'two', level: 1, title: 'One' },
    ]);
  });

  it('warns when the file-level ID is changed, even with a new title', () => {
    expect(check(fileWith('old', 'Before'), fileWith('new', 'After'))).toEqual([
      { kind: 'changed', id: 'old', newId: 'new', level: 0, title: 'Before' },
    ]);
  });

  it('reports a renamed heading with a new ID as removed', () => {
    expect(check(headingWith('One', 'one'), headingWith('Other', 'two'))).toEqual([
      { kind: 'removed', id: 'one', level: 1, title: 'One' },
    ]);
  });

  it('pairs each changed heading with one successor', () => {
    const before = `${headingWith('Same', 'a')}${headingWith('Same', 'b')}`;
    const after = `${headingWith('Same', 'c')}${headingWith('Same', 'd')}`;
    expect(check(before, after)).toEqual([
      { kind: 'changed', id: 'a', newId: 'c', level: 1, title: 'Same' },
      { kind: 'changed', id: 'b', newId: 'd', level: 1, title: 'Same' },
    ]);
  });

  it('warns when an ID is duplicated within the file', () => {
    const before = headingWith('One', 'one');
    const after = `${before}${headingWith('Copy', 'one')}`;
    expect(check(before, after)).toEqual([
      { kind: 'duplicated', id: 'one', level: 1, title: 'One' },
    ]);
  });

  it('warns once however many copies an edit makes', () => {
    const before = headingWith('One', 'one');
    const after = `${before}${before}${before}`;
    expect(check(before, after)).toHaveLength(1);
  });

  it('warns when an edit creates an ID used by another file', () => {
    const before = headingWith('One', 'one');
    const after = `${before}${headingWith('Two', 'elsewhere')}`;
    expect(check(before, after, new Set(['elsewhere']))).toEqual([
      { kind: 'duplicated', id: 'elsewhere', level: 1, title: 'Two' },
    ]);
  });

  it('warns about both when a changed ID is already in use', () => {
    expect(check(headingWith('One', 'one'), headingWith('One', 'other'), new Set(['other']))).toEqual(
      [
        { kind: 'changed', id: 'one', newId: 'other', level: 1, title: 'One' },
        { kind: 'duplicated', id: 'other', level: 1, title: 'One' },
      ],
    );
  });

  it('does not warn about duplicates that were already there', () => {
    const conflictCopy = fileWith('same');
    expect(check(conflictCopy, `${conflictCopy}Edited\n`, new Set(['same']))).toEqual([]);
    const twice = `${headingWith('One', 'one')}${headingWith('Two', 'one')}`;
    expect(check(twice, `${twice}Edited\n`)).toEqual([]);
  });

  it('does not warn when a duplicate is removed and the ID lives on', () => {
    const one = headingWith('One', 'one');
    expect(check(`${one}${headingWith('Two', 'one')}`, one)).toEqual([]);
  });

  it('does not warn when a new heading gets a new ID', () => {
    const before = headingWith('One', 'one');
    expect(check(before, `${before}${headingWith('Two', 'two')}`)).toEqual([]);
  });

  it('does not warn for edits that leave IDs alone', () => {
    const text = `${fileWith('file')}${headingWith('One', 'one')}`;
    expect(check(text, text.replace('Text', 'Changed').replace('One', 'Renamed'))).toEqual([]);
  });

  it('Editing a note without an ID', () => {
    const text = '#+title: No ID\n* Heading\nBody\n';
    const doc = scan(text);
    const body = spliceBody(text, doc, editableBody(text, doc).replace('Body', 'Edited'));
    const titled = spliceTitle(body.text, scan(body.text), 'Renamed');
    const after = scan(titled.text);
    expect(editableTitle(after)).toBe('Renamed');
    expect(titled.text).toBe('#+title: Renamed\n* Heading\nEdited\n');
    expect(after.nodes).toEqual([]);
    expect(checkIdChanges(doc, after)).toEqual([]);
  });
});
