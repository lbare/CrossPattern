import { useState } from 'react';
import { Modal } from './dialogs';
import { SHORTCUTS } from './extras';
import convertShot from '../docs/convert.png';
import editorShot from '../docs/editor.png';
import guideShot from '../docs/guide-photo.jpg';
import stitchShot from '../docs/stitching.png';

/** The in-app guide. Each section is a list of [heading, explanation] pairs. */
const SECTIONS: { title: string; intro?: string; image?: [string, string]; items: [string, string][] }[] = [
  {
    title: 'Getting started',
    intro: 'CrossPattern is a cross stitch pattern editor that runs entirely in your browser. There is nothing to install and no account; your work stays on your own computer.',
    image: [editorShot, 'The editor with a pattern made from a photo of a kitten and a plant'],
    items: [
      ['Draw from scratch', 'Pick a color on the right, pick a tool on the left, and click or drag on the grid. Every square is one stitch. The bold lines mark every tenth stitch.'],
      ['Stitching it', 'When the pattern is ready, Stitch ✓ opens a screen for working through it color by color and section by section, ticking stitches off as you go. It works well on a phone. See "Stitching".'],
      ['Start from a picture', 'Press Convert picture, choose a photo, crop it to the size you want to stitch, then mark what to keep, flatten or remove. See "Converting a picture".'],
      ['Moving around', 'Scroll to move, pinch or hold ⌘/Ctrl while scrolling to zoom, and press 0 to fit the pattern to the window. Hold Space and drag to move with any tool. With the Move view tool, clicking a stitch tells you its color, symbol and how many there are.'],
      ['Nothing is lost', 'Every change is saved automatically, and Undo (⌘/Ctrl Z) goes back up to 100 steps.'],
    ],
  },
  {
    title: 'Drawing tools',
    items: [
      ['Pencil and Eraser', 'Add or remove stitches. Change the brush size with the Size menu or the [ and ] keys.'],
      ['Recolor brush', 'Replaces only the color you start the stroke on with the current color. Everything else under the brush is left alone, so you can fix one color without going outside the lines.'],
      ['Tidy brush', 'Brush over a noisy patch and stray stitches are absorbed into the colors around them. It only affects where you brush.'],
      ['Restore brush', 'Paints back the stitches from the first conversion of a picture, for when you have simplified too far.'],
      ['Shape select', 'Click a patch of color and the whole patch is selected; Shift-click adds more. A bar then lets you fill it with the current color, absorb it into whatever surrounds it, erase it, grow or shrink it by one stitch, smooth its edge, or outline it in backstitch. "All of this color" widens the selection to that color everywhere. Most cleanup is "this blob should be that color", and this does it in two clicks.'],
      ['Fill', 'Fills a connected area with the current color. Shift-click replaces that color everywhere in the pattern.'],
      ['Pick color', 'Click a stitch to use its color. Shift-click takes the exact shade from the guide photo and adds it to the palette. Holding Alt with most tools picks a color without switching tools.'],
      ['Line, Rectangle, Ellipse', 'Drag to draw the shape. Hold Shift for a filled rectangle or ellipse.'],
      ['Backstitch', 'Drag between grid corners to add an outline line on top of the stitches. Alt-click a line to remove it.'],
      ['Mirror', 'With Mirror on, everything you paint is repeated on the other side of the centre line. Useful for faces and symmetric motifs.'],
    ],
  },
  {
    title: 'Colors',
    items: [
      ['The palette', 'The list on the right shows every color with its chart symbol and how many stitches use it. Click one to paint with it. Sort puts the most-used colors first.'],
      ['Editing a color', 'With a color selected you can change its shade, type a hex code, or choose a different symbol.'],
      ['Highlight', 'Fades every other color so you can see exactly where one color is used.'],
      ['Lock', 'A locked color cannot be painted over by any tool. Lock the parts you are happy with before cleaning up around them.'],
      ['Merge into', 'Replaces the selected color everywhere with another color and removes it from the palette.'],
      ['Simplify', 'Clean up… merges look-alike and rarely used colors, absorbs small patches and smooths edges, with a preview first. Reduce to N colors merges the least-used colors into their nearest neighbours. Remove stray stitches clears isolated stitches across the whole pattern. Outline adds a border around the design, as backstitch or as stitches.'],
      ['Fabric color', 'Set the fabric color at the bottom of the panel to preview the design on dark or colored cloth. Empty squares show the fabric.'],
    ],
  },
  {
    title: 'Converting a picture',
    intro: 'Conversion has two steps, in a window that fills the screen. The aim is a pattern you can actually stitch: few colors, clean shapes, no speckle. Everything is saved as you go, so closing the window or refreshing the page loses nothing.',
    image: [convertShot, 'Converting a photo: the cat and the roof are areas, and part of the wall is selected'],
    items: [
      ['1. Crop and size', 'Type the width and height in stitches. The crop box takes that shape; drag it, or a corner, to choose what goes in. The total stitch count and finished size on your fabric are shown as you go.'],
      ['2. Select, then say what it is', 'It works like selecting in a picture editor. First select something on the photo; the selection shows in blue. Then press New area, Remove or Unmark to say what it is. Do the same for the next thing.'],
      ['Shapes', 'The photo is split into its obvious shapes for you. Move over it to see them light up, and click one to select it or drag across several. Shape size makes them coarser or finer.'],
      ['Smart brush', 'Paint roughly along something and the brush follows its real edges, taking in the whole thing rather than just what is under the brush. Reach sets how far it spreads into similar color nearby; at 0 it takes only what you paint over.'],
      ['Lasso', 'Draw around something and everything inside is selected.'],
      ['Snap to edges', 'When you finish a stroke with any tool, the edge you made moves onto the nearest real edge in the photo, whether you were adding or taking away. So a rough outline lands on the edge of the roof instead of a little over it. Turn it off with "Snap to edges in the photo". The Snap edges button does the same for the whole selection, and "Snap area edges" tidies the lines between areas you have already made, where one has strayed over into the next.'],
      ['Eraser', 'Paint over part of an area to unmark just that part. It only erases the area you start the stroke on, so neighbouring areas are safe, and it follows the photo\'s edges like the smart brush.'],
      ['Brush size', 'The brush size is measured on screen, so zooming in gives a finer brush for small details. [ and ] make it smaller and bigger.'],
      ['Adding and taking away', 'Every tool adds to the selection, or takes away from it when "Take away" is chosen. Holding Shift always adds and holding Alt always takes away, so you can select an object roughly and then trim what should not be in it.'],
      ['Tidying a selection', 'Smooth rounds off ragged edges and drops specks. Grow and Shrink move the edge out or in. Fill gaps closes holes inside. Invert swaps what is selected and what is not.'],
      ['Areas', 'An area is one thing in the picture: the cat, the roof, a wall. Each area has colors of its own, so one area never uses up another\'s colors. Click an area in the list to set how much detail it keeps (1 flat color, 2 to 6 tones, or Full detail) and whether its edge is crisp or soft. Change loads the area back as the selection so you can add to it or trim it, then Update.'],
      ['Soft edges', 'A soft edge blends an area into what is next to it over one to three stitches, instead of ending on a hard line. Crisp areas can have a dark outline; soft ones do not.'],
      ['Removing a background', 'Make your areas, then press "Remove the rest". Or select the background itself and press Remove.'],
      ['Zooming in', 'Pinch or hold ⌘/Ctrl while scrolling over the photo to zoom in for small features. Scroll or hold Space and drag to move around. On a touch screen, two fingers pinch and move.'],
      ['Photo, Both, Pattern', 'Above the pictures, choose whether to see the photo, the pattern, or both side by side. Showing one at a time makes it as big as the window allows.'],
      ['Colors and simplifying', 'Colors sets how many thread colors to use. Flatten smooths shading in unmarked areas. Remove stray stitches clears single stitches. Adjust the photo lifts shadows and changes brightness, contrast and color strength first.'],
      ['Cleaning up afterwards', 'When you create the pattern, Clean up offers to merge look-alike colors, drop colors hardly used, absorb small patches into what surrounds them and smooth jagged edges. Every stitch that would change is ringed in the preview before anything happens. Skip it if you like; it is also under Simplify in the color panel, and Undo reverses it.'],
      ['Changing your mind later', 'A pattern remembers the conversion it came from. "Edit conversion" at the top of the right panel reopens it with the same crop, marks and settings.'],
      ['A good order', 'Select the main subject with the smart brush and make it an area with 3 or 4 tones. Add other objects as their own areas with fewer tones. Remove the rest. Then adjust each area\'s detail and edge until it looks right.'],
    ],
  },
  {
    title: 'Fine-tuning',
    image: [guideShot, 'The original photo faded over the pattern as a guide'],
    items: [
      ['Guide picture', 'After converting, the photo and the first conversion are kept. Show either one over your pattern from the top of the right panel, and use the slider to fade between it and your stitches. Hold P to see the guide in full.'],
      ['Tracing', 'On any pattern you can add a photo to trace over with "Add a photo to trace".'],
      ['Re-convert a selection', 'Select an area, press Re-convert in the selection bar, and convert just that part of the photo again with its own color count. Empty squares stay empty unless you say otherwise.'],
      ['Selections', 'Drag with the Select tool, then drag inside to move. The bar above the canvas can flip, rotate, copy, cut, delete, or crop the canvas to the selection. Arrow keys nudge by one square.'],
      ['Canvas size', 'Click the size in the top bar to resize the canvas or trim empty edges.'],
    ],
  },
  {
    title: 'Stitching',
    intro: 'When you sit down to stitch, press Stitch ✓ in the editor. The stitch screen takes you through the pattern one color at a time, and one section of that color at a time, ticking stitches off as you go. Everything is saved as you tick.',
    image: [stitchShot, 'The stitch screen: one color highlighted, finished stitches crossed out, and the current section outlined'],
    items: [
      ['One color at a time', 'Pick a color under Colors. Every other color fades out, so the stitches you are working stand out, and only stitches of that color can be ticked. Untick "Only this color" to see and tick everything.'],
      ['Section by section', 'A section is one separate patch of the color, joined side by side or corner to corner. Sections are numbered from the top of the pattern down, and the current one is outlined in pink. The column and row it starts at match the numbers on a printed chart.'],
      ['Moving between sections', 'Next and Prev move to the next or previous section and bring it into view. Section done ticks every stitch in it and moves on to the suggested next section (see "What to do next"). The Sections list shows them all with their progress; tap one to go to it.'],
      ['Ticking single stitches', 'Tap or click a stitch to tick it, and again to untick. On a computer you can drag across several, and Shift-click ticks a whole section. A ticked stitch turns a lighter shade of its own color with a cross over it, so you can still see which color it is. Undo takes back the last tick.'],
      ['Finishing a color', 'When every stitch of a color is done, Next color moves on to the suggested next color. Your progress for each color shows in the Colors list.'],
      ['The whole pattern', 'The Whole pattern box shows how many stitches are done out of the total, how many are left to go, how many colors are finished and how many you have done this session. A line along the top fills up as you go. On a phone the total is under the pattern name, and the full figures are in the ⋯ menu.'],
      ['On a phone', 'The pattern fills the screen, with one slim bar underneath: the color (tap it to change color), ‹ and › for the previous and next section, the section number (tap it for the list of sections) and ✓ to tick the section off. Tap a stitch to tick it, drag to move and pinch to zoom. The ⋯ button at the top holds the rest: Only this color, Keep screen on, Symbols, Whole pattern, Send and Help. The back button returns to the editor.'],
      ['Picking up where you left off', 'The color and section you were on are remembered for each project. If you leave the site on the stitch screen, it opens there next time.'],
      ['Where you are', 'On a computer, a label beside the mouse gives the column and row of the square under it, numbered like a printed chart, with its color and whether it is stitched.'],
      ['Stitching order', 'Tick "Stitching order" (or press O) for arrows showing how to work the current section: a green Start square, a numbered arrow for each row in turn, dotted lines where you step down to the next row, and End. The row to do next is drawn bold in purple. Rows go from the top down; tall, thin shapes are worked in columns instead.'],
      ['Rows, there and back', 'The usual way to fill an area (the Danish method): work half stitches all along the row, then come back along the same row crossing each one. You finish where the row began, so every row starts on the same side. "One cross at a time" (the English method) finishes each cross before the next and snakes back and forth, which suits scattered stitches.'],
      ['Moving between rows', 'A short dotted line is a step or a short carry across the back. A longer one that only passes over finished stitches means slipping the thread under them on the back. An orange line marked "new thread" is too far to carry: finish off and start again there, so loose loops do not show through or snag.'],
      ['Only what is next', 'To keep the pattern clear, only the rows for the length of thread in your needle (at most eight) are drawn in full, with a "✂ change thread" where it runs out; the rest of the plan is a faint line. Tick "Whole plan" to see every row, with small ✂ marks where new threads start.'],
      ['Following along', 'The panel says which row is next, which way to go and where to go after. "Row done" ticks that row and moves on. The plan only covers stitches you have not ticked, and carries on from the last stitch you ticked, so stitches done out of order, or a section started some other way, are fine: it plans around them.'],
      ['Thread for a section', 'The Stitching order box says how far the thread in your needle will go. The Thread box (click it to open) estimates the thread for what is left of the section, following the stitching order, and how to cut it: how many lengths, how long each is, and where to change thread, at the end of a row where possible. So you do not run out partway along a row, and the last length is cut just long enough, with little wasted. With the stitching order showing, ✂ marks on the pattern show where each new length starts. It also gives the thread left for the whole color, in skeins. Set your fabric count, strands, the longest length you like to thread, and cm or inches there. It is an estimate (about 13 mm a stitch on 14-count, plus about 10 cm a length to start and finish off), so stitchers who pull tighter or looser will use a little less or more.'],
      ['What to do next', 'The Up next box suggests the section to do after this one and the color to move on to, with the reason. The suggested ones are marked in the Sections and Colors lists, and Section done, Next color and picking a color all go to them.'],
      ['Which section next', 'The nearest unfinished section of the color to where your thread will be, rather than the next by number, so the thread can often be carried a few squares or slipped under finished stitches on the back. It says which, or when it is far enough that you should finish off and start a new thread. With the stitching order showing, a teal line leads from where this section ends to the next one.'],
      ['Which color next', 'With nothing stitched yet, the color in the middle of the design: starting in the middle keeps the design centred on your fabric. After that, the color with the most stitches right beside ones you have finished, so you can count from finished work; failing that, the color closest to it. If the pattern has backstitch, it is left until every cross stitch is done, since it goes on top.'],
      ['Measuring', 'Measure (M on a computer, in the ⋯ menu on a phone) counts the squares between two points. Click the square to measure from, then the one to measure to, or drag from one to the other. A dotted path shows the way, with how many squares across and how many down, and the answer appears at the bottom, such as "12 right, 6 down". Clicks measure instead of ticking until you press Done.'],
      ['Starting a new section', '"How far is it from my stitches?" under the section, or "From my stitches to this section" while measuring, measures from the nearest stitch you have already done to where the section starts, so you can count your way over to it.'],
      ['Keys', 'On a computer, ← and → move between sections, Enter ticks the current section off, M measures, O shows the stitching order, and ⌘/Ctrl Z undoes.'],
    ],
  },
  {
    title: 'Projects, saving and printing',
    items: [
      ['Projects', 'Every pattern is a project in the library. Open Projects to switch, duplicate or delete. New, Open and Convert picture each start a new project.'],
      ['Where your work lives', 'Projects are stored in this browser on this computer. They are not uploaded anywhere, and they will not appear on another device or browser.'],
      ['On another device', 'Send (in the editor, or in the stitch screen\'s menu) makes a link and a QR code. Point your phone\'s camera at the code, or copy the link and send it to yourself, and open it on the other device: the project appears there with its progress. The project travels inside the link; nothing is uploaded. The guide photo stays behind to keep the link short.'],
      ['Keeping two devices in step', 'Each link is a copy, not a live connection. When you have stitched on your phone, send it back the same way and choose Update my copy: the pattern comes from the link, and every stitch ticked on either device is kept. Keep both makes a separate copy instead.'],
      ['Backing up and moving', 'Save downloads a project file. Open it (or drop it on the window) on any computer to carry on. Clearing your browser data deletes the library, so keep files of anything important.'],
      ['Export an image', 'Export makes a PNG of the chart, with optional symbols, grid numbers and a color key.'],
      ['Print or save as PDF', 'In Export, "Print or save as PDF" lays the chart out across pages with symbols and row and column numbers, plus a cover page with the color key and finished sizes. Choose "Save as PDF" in the print dialog to keep a file.'],
    ],
  },
];

export function GuideDialog({ onClose, start }: { onClose: () => void; start?: string }) {
  const [tab, setTab] = useState(() => Math.max(0, SECTIONS.findIndex((s) => s.title === start)));
  const titles = [...SECTIONS.map((s) => s.title), 'Keyboard shortcuts'];
  const section = SECTIONS[tab];

  return (
    <Modal title="Guide" onClose={onClose} size="xl">
      <div className="guide">
        <nav>
          {titles.map((t, i) => (
            <button key={t} className={i === tab ? 'on' : ''} onClick={() => setTab(i)}>{t}</button>
          ))}
        </nav>
        <article>
          <h3>{titles[tab]}</h3>
          {section ? (
            <>
              {section.intro && <p className="lead">{section.intro}</p>}
              {section.image && <img className="shot" src={section.image[0]} alt={section.image[1]} />}
              <dl>
                {section.items.map(([head, text]) => (
                  <div key={head}><dt>{head}</dt><dd>{text}</dd></div>
                ))}
              </dl>
            </>
          ) : (
            <div className="shortcuts">
              {SHORTCUTS.map(([title, rows]) => (
                <section key={title}>
                  <h4>{title}</h4>
                  <dl>
                    {rows.map(([key, what]) => (
                      <div key={key}><dt>{key}</dt><dd>{what}</dd></div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          )}
        </article>
      </div>
      <footer>
        <button className="btn primary" onClick={onClose}>Close</button>
      </footer>
    </Modal>
  );
}
