/**
 * Contract C6's view of a file: every module reference the TypeScript compiler (and the bundlers
 * that share its syntax) reads in it, found by walking the AST rather than matching text, so no
 * way of writing a specifier is missed. Pure, so tests/unit/portability.test.ts can test it on
 * strings as well as apply it to src/contact.
 */
import { dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export interface ModuleReference {
  /** 1-based. */
  line: number;
  /** How the module is named: "import declaration", "import()", "require()", and so on. */
  form: string;
  /** The module's name when it is a string literal (or a template with no substitutions), as the compiler reads it. */
  specifier?: string;
  /** What is written where the name goes, for the message. */
  written: string;
}

const literalText = (node: ts.Node | undefined) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined);

const isImportMeta = (node: ts.Node) => ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta';

/**
 * Every module reference in one file: import and export declarations, `import x = require()`,
 * `import()` and `require()` calls, `import()` types (type-only, in code or in a JSDoc type), a
 * JSDoc `@import`, `/// <reference path>` and `/// <reference types>`, and Vite's
 * `import.meta.glob()`. A reference whose name is anything but a string literal (an identifier,
 * a template with a substitution, a concatenation, nothing) comes back with no specifier.
 */
export function moduleReferences(source: string, fileName: string): ModuleReference[] {
  // The script kind (TS, TSX, JS, JSX) follows the file's extension.
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const references: ModuleReference[] = [];
  const lineAt = (position: number) => file.getLineAndCharacterOfPosition(position).line + 1;
  const add = (form: string, at: ts.Node, name: ts.Node | undefined) =>
    references.push({ line: lineAt((name ?? at).getStart(file)), form, specifier: literalText(name), written: name ? name.getText(file) : '(nothing)' });
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add('import declaration', node, node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add('export declaration', node, node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add('import = require()', node, node.moduleReference.expression);
    else if (ts.isImportTypeNode(node)) add('import() type', node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument);
    else if (ts.isJSDocImportTag(node)) add('JSDoc @import', node, node.moduleSpecifier);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) add('import()', node, node.arguments[0]);
      else if (ts.isIdentifier(callee) && callee.text === 'require') add('require()', node, node.arguments[0]);
      else if (ts.isPropertyAccessExpression(callee) && isImportMeta(callee.expression) && /^glob/.test(callee.name.text)) add('import.meta.glob()', node, node.arguments[0]);
    }
    // JSDoc is not a child to forEachChild, but in a .js file its types are what the compiler checks.
    // `jsDoc` is internal to TypeScript. If it ever goes, the rows "find a JSDoc import() type in a
    // .js file" and "find a JSDoc @import in a .js file" (tests/unit/portability.test.ts) fail.
    for (const doc of (node as { jsDoc?: ts.Node[] }).jsDoc ?? []) visit(doc);
    ts.forEachChild(node, visit);
  };
  visit(file);
  // Triple-slash directives are always strings. A `lib` reference names a built-in library, not a module.
  for (const reference of file.referencedFiles) references.push({ line: lineAt(reference.pos), form: '/// <reference path>', specifier: reference.fileName, written: reference.fileName });
  for (const reference of file.typeReferenceDirectives) references.push({ line: lineAt(reference.pos), form: '/// <reference types>', specifier: reference.fileName, written: reference.fileName });
  return references.sort((a, b) => a.line - b.line);
}

/**
 * The file's syntax errors, from the compiler's public API. An unterminated template or comment
 * swallows the rest of a file, and the walk would see none of the references in it.
 */
function syntaxErrors(source: string, fileName: string): { line: number; message: string }[] {
  const { diagnostics = [] } = ts.transpileModule(source, { fileName, reportDiagnostics: true });
  return diagnostics.flatMap(({ file, start, messageText }) =>
    file && start !== undefined ? [{ line: file.getLineAndCharacterOfPosition(start).line + 1, message: ts.flattenDiagnosticMessageText(messageText, ' ') }] : [],
  );
}

/**
 * C6 for one file under `root` (src/contact): the file must parse, and every module reference must
 * be a string literal, relative, and resolve inside `root`. One message per problem, naming the
 * file and line.
 */
export function portabilityProblems(source: string, file: string, root: string): string[] {
  const name = relative(root, file).split(sep).join('/');
  const problems = syntaxErrors(source, file).map(({ line, message }) => `${name}:${line}: the compiler cannot parse this file: ${message}`);
  for (const { line, form, specifier, written } of moduleReferences(source, file)) {
    const at = `${name}:${line}`;
    if (specifier === undefined) problems.push(`${at}: ${form} names its module with ${written}, not a string literal`);
    else if (!/^\.\.?\//.test(specifier)) problems.push(`${at}: ${specifier} is not a relative import`);
    else if (relative(root, resolve(dirname(file), specifier)).startsWith('..')) problems.push(`${at}: ${specifier} leaves src/contact`);
  }
  return problems;
}
