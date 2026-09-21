const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  BorderStyle,
  AlignmentType,
  PageBreak,
  LevelFormat,
} = require("docx");
const fs = require("fs");

const NAVY = "16365C";
const STEEL = "5B6274";
const LIGHT = "ECEEF2";

const PAGE_W = 12240; // US Letter
const MARGIN = 1080;
const CONTENT_W = PAGE_W - MARGIN * 2;

/* ------------------------------ helpers ------------------------------ */

const h1 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 160 },
    children: [new TextRun({ text, bold: true, size: 32, color: NAVY })],
  });

const h2 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120 },
    children: [new TextRun({ text, bold: true, size: 24, color: NAVY })],
  });

const p = (text, opts = {}) =>
  new Paragraph({
    spacing: { after: opts.after ?? 120 },
    children: [
      new TextRun({
        text,
        size: opts.size ?? 21,
        italics: opts.italics,
        bold: opts.bold,
        color: opts.color,
      }),
    ],
  });

const bullet = (text) =>
  new Paragraph({
    numbering: { reference: "dots", level: 0 },
    spacing: { after: 80 },
    children: [new TextRun({ text, size: 21 })],
  });

const note = (text) =>
  new Paragraph({
    spacing: { before: 120, after: 160 },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: NAVY, space: 12 } },
    indent: { left: 180 },
    children: [new TextRun({ text, size: 20, color: STEEL })],
  });

/** A line for someone to write on. */
const writeLine = (label, lines = 1) => {
  const out = [
    new Paragraph({
      spacing: { before: 140, after: 40 },
      children: [new TextRun({ text: label, size: 20, bold: true, color: STEEL })],
    }),
  ];
  for (let i = 0; i < lines; i++) {
    out.push(
      new Paragraph({
        spacing: { after: 100 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "C3C8D3", space: 4 } },
        children: [new TextRun({ text: "", size: 21 })],
      })
    );
  }
  return out;
};

const cell = (text, { bold, width, shade, size } = {}) =>
  new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: shade ? { type: ShadingType.CLEAR, fill: shade } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({
        children: [new TextRun({ text, bold, size: size ?? 19, color: bold ? NAVY : undefined })],
      }),
    ],
  });

const table = (widths, rows, { headerShade = LIGHT } = {}) =>
  new Table({
    columnWidths: widths,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    rows: rows.map(
      (r, i) =>
        new TableRow({
          tableHeader: i === 0,
          children: r.map((t, j) =>
            cell(t, { bold: i === 0, width: widths[j], shade: i === 0 ? headerShade : undefined })
          ),
        })
    ),
  });

/** Blank grid for filling in on the floor. */
const blankTable = (widths, headers, bodyRows) => {
  const rows = [headers];
  for (let i = 0; i < bodyRows; i++) rows.push(headers.map(() => ""));
  return table(widths, rows);
};

const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

/* ------------------------------ content ------------------------------ */

const children = [];

// ---- Cover ---------------------------------------------------------------
children.push(
  new Paragraph({
    spacing: { after: 60 },
    children: [new TextRun({ text: "THERMAL CORP MES", bold: true, size: 20, color: STEEL })],
  }),
  new Paragraph({
    spacing: { after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 24, color: "C2D62E", space: 8 } },
    children: [
      new TextRun({ text: "Factory discovery pack", bold: true, size: 48, color: NAVY }),
    ],
  }),
  p(
    "Everything in this pack exists to answer one question: how does one real order actually move through your shop, from the day it is taken to the day it ships?",
    { size: 22 }
  ),
  p(
    "The software already runs. What it does not yet know is your floor — the station list currently in it was inferred from your published Air Handlers catalogue and is a placeholder. One real order replaces all of that guesswork.",
    { size: 22 }
  ),
  note(
    "Bring this to the visit. Part A is what to request beforehand. Part B is filled in during the walk. Part C is what to say, and not say, when demonstrating the software."
  )
);

// ---- Part A --------------------------------------------------------------
children.push(pageBreak(), h1("Part A — Request before the visit"));

children.push(
  p(
    "Four things matter more than everything else combined. Ask for a recent completed order, not a live one, so somebody can walk through what actually happened — including the delays and the changes."
  )
);

children.push(
  table(
    [700, 3800, 5520],
    [
      ["#", "What to ask for", "Why it matters"],
      [
        "1",
        "One anonymised customer order or job sheet",
        "Tells us what a job looks like at intake, and what the office promises the customer.",
      ],
      [
        "2",
        "Its bill of materials — parts, quantities, units",
        "Tells us what is purchased versus made in-house, and which units are used (pieces, feet, square feet, pounds).",
      ],
      [
        "3",
        "The production traveler, checklist or spreadsheet used today",
        "This is the current system. Whatever the software replaces has to do at least this much.",
      ],
      [
        "4",
        "A walkthrough with one supervisor and one worker",
        "The paperwork says what should happen. These two say what does happen. Both are needed.",
      ],
    ]
  )
);

children.push(
  h2("Useful if easily available"),
  bullet("Finished product drawing and the configuration options chosen for that order"),
  bullet("Which sub-assemblies they build versus buy in"),
  bullet("Inspection records and shipping paperwork for that same order"),
  note(
    "If only one thing can be obtained, make it the production traveler for a completed order. It usually reveals the real sequence, the sign-offs, and where things went wrong."
  )
);

children.push(
  h2("A note you can send with the request"),
  p(
    "“To tailor the system to how you actually build, we would like to follow one completed order end to end — ideally one that had a hiccup, since that teaches us more than a clean one. If you can share the job sheet, its parts list, and whatever traveler or spreadsheet the floor used, plus half an hour each with a supervisor and someone on the line, we can map your real process rather than assume one. Everything can be anonymised; we do not need customer names or pricing.”",
    { italics: true }
  )
);

// ---- Part B --------------------------------------------------------------
children.push(pageBreak(), h1("Part B — Fill in during the visit"));

children.push(h2("B1. The order being followed"));
children.push(
  ...writeLine("Order reference (anonymised) and product / configuration"),
  ...writeLine("Date taken, date promised, date actually shipped"),
  ...writeLine("What went wrong or changed along the way")
);

children.push(h2("B2. Operations, in the order they happen"));
children.push(
  p(
    "One row per operation. The two columns that matter most are the last two — they are what the software currently gets wrong.",
    { size: 20, color: STEEL }
  )
);
children.push(
  blankTable(
    [2400, 1800, 2900, 2900],
    ["Operation — what happens", "Station / dept", "Cannot start until…", "Can run at the same time as…"],
    9
  )
);
children.push(
  note(
    "Press on the difference between something physically required and something merely done in that order out of habit. If the software treats habit as a hard rule, it will block work that could have gone ahead."
  )
);

children.push(h2("B3. For each operation, also ask"));
children.push(
  ...writeLine("Can part of a batch move forward before the rest is finished? (e.g. 4 of 8 panels)"),
  ...writeLine("Who decides an operation is finished, and what do they check?"),
  ...writeLine("What happens when a part is missing, defective, or changed mid-job?")
);

children.push(pageBreak(), h2("B4. How material actually moves"));
children.push(
  ...writeLine("Who receives, stores, picks and issues material?"),
  ...writeLine("Is material issued per job, per operation, or in bulk to the line?"),
  ...writeLine("Can a worker simply take material off the rack themselves?"),
  ...writeLine("How are unused material, scrap and replacements recorded today?"),
  ...writeLine("Do coils, motors or anything else need serial or lot tracking?"),
  ...writeLine("Which units are used — pieces, feet, square feet, pounds?"),
  ...writeLine("Are the current stock counts trusted? If not, why not?")
);
children.push(
  note(
    "One specific thing to settle: the software currently issues a step's materials the moment a worker taps Start. If your storeman picks and issues separately, that should become its own “materials picked” action instead. Ask directly."
  )
);

children.push(h2("B5. People, shifts and time"));
children.push(
  ...writeLine("Headcount: workers / supervisors / stations / shifts"),
  ...writeLine("Do workers move between stations during a shift?"),
  ...writeLine("Can several people work one operation? Can one person run several machines?"),
  ...writeLine("Shared tablets, personal phones, or fixed PCs?"),
  ...writeLine("Is time tracking for job costing, payroll, or both?"),
  ...writeLine("Who approves corrections, overtime and forgotten clock-outs?"),
  ...writeLine("What languages are spoken on the floor? Do workers wear gloves?")
);

children.push(pageBreak(), h2("B6. Customisation and engineering changes"));
children.push(
  ...writeLine("What actually differs between two orders for the same product?"),
  ...writeLine("Who creates and approves the BOM and the process?"),
  ...writeLine("How are drawings revised, and how does the floor learn of a revision?"),
  ...writeLine("What happens when engineering changes a job already in production?"),
  ...writeLine("Do substitute materials need approval? From whom?")
);

children.push(h2("B7. Systems and IT"));
children.push(
  ...writeLine("What is used today for accounting, purchasing, inventory, payroll, CAD, order entry?"),
  ...writeLine("Which system should own which record? (Ask for sample exports.)"),
  ...writeLine("Cloud hosting allowed, or must it run on-premises?"),
  ...writeLine("Is Wi-Fi reliable across the whole floor? What should happen in an outage?"),
  ...writeLine("Who handles IT and user accounts? Support hours and acceptable downtime?")
);

children.push(h2("B8. What would make them buy it"));
children.push(
  p(
    "Ask the person who signs and the people who would use it, separately. Their answers usually differ, and both matter.",
    { size: 20, color: STEEL }
  ),
  ...writeLine("The three most expensive or most irritating problems today — and how often each happens"),
  ...writeLine("What measurable improvement would make a pilot a success?"),
  ...writeLine("Which department or line could pilot it?"),
  ...writeLine("Who would own the rollout internally? What budget and purchasing process apply?")
);

// ---- Part C --------------------------------------------------------------
children.push(pageBreak(), h1("Part C — Demonstrating the software"));

children.push(
  p(
    "There is a working system to show, running on clearly labelled sample data. It is worth showing, because it makes the conversation concrete. But be precise about what is real."
  )
);

children.push(h2("Safe to show and claim"));
children.push(
  bullet("Workers see only their own station's steps, tap Start and Mark done, and flag blockers with a reason."),
  bullet("Anyone signed in can open a unit and see every sub-assembly's progress, and what final assembly is waiting on."),
  bullet("Times are recorded automatically; workers cannot edit them, and supervisor corrections keep the original with a name and reason."),
  bullet("Stock is reserved then issued, cannot go negative, and a repeated tap cannot consume material twice."),
  bullet("Admins can add a product, define its own process and parts list, and raise a work order without a developer.")
);

children.push(h2("Say plainly, unprompted"));
children.push(
  note(
    "“The stations and the build sequence you are looking at are our placeholder, worked out from your published catalogue. They are almost certainly not how your floor really runs. Replacing them with your actual process is exactly why we are here.”"
  ),
  p(
    "Saying this first costs nothing and buys credibility. If they spot it themselves after you have presented it as theirs, it costs a great deal."
  )
);

children.push(h2("Do not claim"));
children.push(
  bullet("That it is ready for live production use. It is not — it holds demonstration data only."),
  bullet("That parallel work is handled. Steps are currently gated in simple sequence; genuine dependencies are the next build."),
  bullet("That it integrates with their accounting or purchasing. Nothing is connected yet."),
  bullet("Any delivery date. That depends on what this visit turns up.")
);

children.push(h2("After the visit"));
children.push(
  p(
    "With the four items from Part A and the notes from Part B, the next step is a written workflow for that one order — its real operations, what each waits on, and where material is issued — and a pilot scope narrow enough to prove value on one line."
  )
);

/* ------------------------------ document ------------------------------ */

const doc = new Document({
  numbering: {
    config: [
      {
        reference: "dots",
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360, hanging: 200 } } },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: PAGE_W, height: 15840 },
          margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        },
      },
      children,
    },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(process.argv[2] || "discovery-pack.docx", buf);
  console.log("written");
});
