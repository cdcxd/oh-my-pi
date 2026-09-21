import { beforeAll, describe, expect, it } from "bun:test";
import { Editor, type EditorBorderStyle } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { defaultEditorTheme } from "./test-themes";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const BUILTIN_STYLE_IDS = ["box", "band", "claude", "pi", "borderless", "rule", "field", "rail"] as const;

/** Rendered rows with chrome intact but ANSI stripped, so string indices are
 * terminal columns — the same coordinates an SGR mouse report carries. */
function rendered(editor: Editor, width: number): string[] {
	return editor.render(width).map(row => Bun.stripANSI(row));
}

function locate(rows: readonly string[], needle: string): { row: number; col: number } {
	for (let row = 0; row < rows.length; row++) {
		const index = rows[row]!.indexOf(needle);
		if (index >= 0) {
			// Cell column, not code-unit index: wide graphemes occupy two
			// cells and SGR reports columns in cells.
			return { row, col: visibleWidth(rows[row]!.slice(0, index)) };
		}
	}
	throw new Error(`expected a rendered row containing ${JSON.stringify(needle)}`);
}

describe("editor click-to-cursor mapping", () => {
	beforeAll(() => initTheme());
	it("maps a click on the text through every built-in composer style's chrome", () => {
		for (const style of BUILTIN_STYLE_IDS satisfies readonly EditorBorderStyle[]) {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderStyle(style);
			editor.setText("hello world");
			const rows = rendered(editor, 40);
			const { row, col } = locate(rows, "world");
			expect(editor.clickToCursor(row, col + 1), `${style}: click after the w`).toBe(true);
			expect(editor.getCursor(), `${style}: cursor lands after the w`).toEqual({ line: 0, col: 7 });
		}
	});

	it("clamps a click past the row's text to the end of that visual line", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("short");
		const rows = rendered(editor, 40);
		const { row } = locate(rows, "short");
		expect(editor.clickToCursor(row, 39)).toBe(true);
		expect(editor.getCursor()).toEqual({ line: 0, col: 5 });
	});

	it("maps a click on a wrapped row back to the logical offset inside the line", () => {
		const text = "the quick brown fox jumps over the lazy dog";
		const editor = new Editor(defaultEditorTheme);
		editor.setText(text);
		const rows = rendered(editor, 20);
		// "fox" must sit on a continuation row for this to prove wrap mapping.
		const fox = locate(rows, "fox");
		const first = locate(rows, "the");
		expect(fox.row).toBeGreaterThan(first.row);
		expect(editor.clickToCursor(fox.row, fox.col)).toBe(true);
		expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("fox") });
	});

	it("lands before a wide grapheme when clicked anywhere inside it", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("漢字abc");
		const rows = rendered(editor, 40);
		const kanji = locate(rows, "漢");
		// 漢 occupies two cells; its second cell must still map before 漢.
		expect(editor.clickToCursor(kanji.row, kanji.col + 1)).toBe(true);
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		const ji = locate(rows, "字");
		expect(editor.clickToCursor(ji.row, ji.col)).toBe(true);
		expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
	});

	it("targets the clicked logical line in a multi-line draft", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("one\ntwo");
		const rows = rendered(editor, 40);
		const two = locate(rows, "two");
		expect(editor.clickToCursor(two.row, two.col + 1)).toBe(true);
		expect(editor.getCursor()).toEqual({ line: 1, col: 1 });
	});

	it("maps clicks on the scrolled-in visible rows of an overflowing editor", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setMaxHeight(2);
		editor.setText("alpha\nbeta\ngamma\ndelta");
		const rows = rendered(editor, 40);
		// The cursor rests at the end, so the viewport scrolled to the last lines.
		const delta = locate(rows, "delta");
		expect(rows.some(row => row.includes("alpha"))).toBe(false);
		expect(editor.clickToCursor(delta.row, delta.col)).toBe(true);
		expect(editor.getCursor()).toEqual({ line: 3, col: 0 });
	});

	it("rejects chrome and popup rows so callers keep their own click handling", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello world");
		const rows = rendered(editor, 40);
		const { row } = locate(rows, "hello");
		if (row > 0) {
			expect(editor.clickToCursor(row - 1, 5)).toBe(false);
		}
		expect(editor.clickToCursor(rows.length, 5)).toBe(false);
		expect(editor.clickToCursor(rows.length + 5, 5)).toBe(false);
	});

	it("accepts a click on an empty draft without moving off the single cell", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setBorderStyle("borderless");
		const rows = rendered(editor, 40);
		expect(rows.length).toBeGreaterThan(0);
		// Borderless: row 0 is the only content row; any column maps to the
		// single position an empty buffer has.
		expect(editor.clickToCursor(0, 3)).toBe(true);
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	});
});

describe("editor mouse selection", () => {
	it("selects between two points without moving the caret", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello world");
		const rows = rendered(editor, 40);
		const hello = locate(rows, "hello");
		expect(editor.beginMouseSelection(hello.row, hello.col + 1)).toBe(true); // after 'h'
		expect(editor.extendMouseSelection(hello.row, hello.col + 5)).toBe(true); // after 'ello'
		expect(editor.getSelectedText()).toBe("ello");
		expect(editor.hasMouseSelection()).toBe(true);
		// The caret stayed at the end of the draft: a selection never moves it.
		expect(editor.getCursor()).toEqual({ line: 0, col: 11 });
	});

	it("selects right-to-left and across wrapped rows by buffer offsets", () => {
		const text = "the quick brown fox jumps over the lazy dog";
		const editor = new Editor(defaultEditorTheme);
		editor.setText(text);
		const rows = rendered(editor, 20);
		const fox = locate(rows, "fox");
		const quick = locate(rows, "quick");
		// Drag from the start of "fox" back to the start of "quick".
		expect(editor.beginMouseSelection(fox.row, fox.col)).toBe(true);
		expect(editor.extendMouseSelection(quick.row, quick.col)).toBe(true);
		expect(editor.getSelectedText()).toBe("quick brown ");
	});

	it("paints the selection with the theme fill until cleared", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello world");
		const rows = rendered(editor, 40);
		const world = locate(rows, "world");
		editor.beginMouseSelection(world.row, world.col);
		editor.extendMouseSelection(world.row, world.col + 5);
		const painted = editor.render(40);
		expect(painted.some(line => line.includes("\x1b[49m"))).toBe(true);
		editor.clearMouseSelection();
		expect(editor.render(40).some(line => line.includes("\x1b[49m"))).toBe(false);
	});

	it("clears the selection on a cursor-moving click and on text edits", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello world");
		const rows = rendered(editor, 40);
		const world = locate(rows, "world");
		editor.beginMouseSelection(world.row, world.col);
		editor.extendMouseSelection(world.row, world.col + 5);
		expect(editor.hasMouseSelection()).toBe(true);

		// A click elsewhere in the draft drops the selection and moves the caret.
		const hello = locate(rows, "hello");
		expect(editor.clickToCursor(hello.row, hello.col + 2)).toBe(true);
		expect(editor.hasMouseSelection()).toBe(false);
		expect(editor.getCursor()).toEqual({ line: 0, col: 2 });

		// Editing clears a fresh selection too.
		editor.beginMouseSelection(world.row, world.col);
		editor.extendMouseSelection(world.row, world.col + 5);
		editor.insertText("X");
		expect(editor.hasMouseSelection()).toBe(false);
	});

	it("clamps a drag past the editor to the nearest text", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello world");
		const rows = rendered(editor, 40);
		const hello = locate(rows, "hello");
		editor.beginMouseSelection(hello.row, hello.col + 2);
		// Drag far past the row's end and below the editor: selects to the end.
		editor.extendMouseSelection(rows.length + 3, 80);
		expect(editor.getSelectedText()).toBe("llo world");
	});

	it("holds no selection for a zero-width drag", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("hello world");
		const rows = rendered(editor, 40);
		const world = locate(rows, "world");
		editor.beginMouseSelection(world.row, world.col + 2);
		editor.extendMouseSelection(world.row, world.col + 2);
		expect(editor.hasMouseSelection()).toBe(false);
		expect(editor.getSelectedText()).toBeUndefined();
	});
});
