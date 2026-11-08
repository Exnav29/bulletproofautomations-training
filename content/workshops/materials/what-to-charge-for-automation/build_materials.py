"""Builds the participant materials for Get Paid for Automation, workshop 01.

    py build_materials.py      (needs openpyxl and python-docx)

Writes, next to this file:
  pricing-worksheet.xlsx       the worksheet used in the workshop and the clinic
  quotation-template.docx      an editable project quotation

The worksheet's formulas use only functions Excel and Google Sheets share
(SUM, IF, ROUND, CEILING, VLOOKUP, MAX, IFERROR), so it works in either.
Example figures are illustrations for practice, marked as such in the file;
they are not market rates and not advice.
"""
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt, RGBColor

HERE = Path(__file__).resolve().parent
INK = "0E1A15"
INPUT = PatternFill("solid", fgColor="FFF4CC")   # yellow: type your own figure here
RESULT = PatternFill("solid", fgColor="E3F1EA")  # green: calculated, do not overwrite
HEAD = Font(name="Arial", bold=True, size=14, color=INK)
BOLD = Font(name="Arial", bold=True, color=INK)
BODY = Font(name="Arial", color=INK)
NOTE = Font(name="Arial", italic=True, color="52615B", size=9)
THIN = Side(style="thin", color="C9C1B4")
BOX = Border(top=THIN, bottom=THIN, left=THIN, right=THIN)
GHS = '"GHS "#,##0.00'
GHS0 = '"GHS "#,##0'
PCT = "0%"


def sheet(wb, title, widths):
    ws = wb.create_sheet(title)
    for col, w in widths.items():
        ws.column_dimensions[col].width = w
    ws.sheet_view.showGridLines = False
    return ws


def put(ws, ref, value, font=BODY, fill=None, fmt=None, wrap=False):
    c = ws[ref]
    c.value = value
    c.font = font
    if fill:
        c.fill = fill
        c.border = BOX
    if fmt:
        c.number_format = fmt
    if wrap:
        c.alignment = Alignment(wrap_text=True, vertical="top")
    return c


def legend(ws, row):
    put(ws, f"A{row}", "Yellow cells: type your own figures. Green cells: calculated, do not overwrite.", NOTE)


def build_workbook():
    wb = Workbook()
    wb.remove(wb.active)

    # ------------------------------------------------------------------ Read me
    ws = sheet(wb, "Read me", {"A": 100})
    lines = [
        ("Pricing worksheet", HEAD),
        ("Get Paid for Automation, workshop 01: You know automation. Do you know what to charge?", BOLD),
        ("Bulletproof Automations. For participants' own use.", NOTE),
        ("", BODY),
        ("How to use it, in order", BOLD),
        ("1. Your costs: what it costs you to run your practice each month, and the minimum hourly rate that covers it.", BODY),
        ("2. Project estimate: the hours a project really takes, including discovery, testing, revisions and support, plus risk.", BODY),
        ("3. Value check: what the client's problem costs them today, so you can see whether your price makes sense to them.", BODY),
        ("4. Price decision: hourly, fixed-project and value-informed prices side by side, and the price you choose.", BODY),
        ("5. Pricing clinic: the practice project used in the workshop's final hour.", BODY),
        ("6. Pricing mistakes: the errors that cost automation practitioners most, and the fix for each.", BODY),
        ("", BODY),
        ("The figures already in the yellow cells are examples so you can see the sheet working.", BODY),
        ("They are not market rates and not a recommendation. Replace every one with your own before you quote.", BODY),
        ("", BODY),
        ("Works in Microsoft Excel and Google Sheets (File > Import in Sheets).", NOTE),
    ]
    for i, (text, font) in enumerate(lines, start=1):
        put(ws, f"A{i}", text, font, wrap=True)

    # --------------------------------------------------------------- 1 Your costs
    ws = sheet(wb, "1 Your costs", {"A": 52, "B": 18, "C": 60})
    put(ws, "A1", "1. Your costs and your minimum hourly rate", HEAD)
    legend(ws, 2)
    put(ws, "A4", "Monthly business costs", BOLD)
    put(ws, "B4", "GHS per month", BOLD)
    put(ws, "C4", "Notes", BOLD)
    costs = [
        ("Automation platform and software subscriptions", 900, "n8n, Make, Zapier, Microsoft licences, AI APIs you pay for yourself"),
        ("Hosting and servers", 300, "Self-hosted instances, databases, domains"),
        ("Internet and mobile data", 450, ""),
        ("Electricity and backup power", 400, "Include fuel or inverter costs if you rely on them"),
        ("Laptop and equipment (monthly share)", 500, "Replacement cost divided by the months it lasts"),
        ("Workspace", 0, "Co-working desk or a share of home costs"),
        ("Bank, MoMo and payment fees", 150, "Including fees on client payments"),
        ("Accounting, registration and legal", 200, ""),
        ("Learning and certifications", 250, ""),
        ("Marketing and business development", 200, ""),
        ("Other", 0, ""),
    ]
    for i, (name, amount, note) in enumerate(costs, start=5):
        put(ws, f"A{i}", name)
        put(ws, f"B{i}", amount, fill=INPUT, fmt=GHS0)
        put(ws, f"C{i}", note, NOTE)
    last = 4 + len(costs)
    put(ws, f"A{last + 1}", "Total monthly business costs", BOLD)
    put(ws, f"B{last + 1}", f"=SUM(B5:B{last})", BOLD, RESULT, GHS0)

    r = last + 3
    put(ws, f"A{r}", "What you need to earn", BOLD)
    put(ws, f"A{r + 1}", "Monthly take-home pay you need")
    put(ws, f"B{r + 1}", 6000, fill=INPUT, fmt=GHS0)
    put(ws, f"A{r + 2}", "Buffer for slow months and unpaid invoices")
    put(ws, f"B{r + 2}", 0.15, fill=INPUT, fmt=PCT)
    put(ws, f"C{r + 2}", "Freelance income is uneven. The buffer pays you in the months that are quiet.", NOTE)
    put(ws, f"A{r + 3}", "Tax and statutory contributions set aside")
    put(ws, f"B{r + 3}", 0.10, fill=INPUT, fmt=PCT)
    put(ws, f"C{r + 3}", "Use the rate that applies to you. Ask a tax adviser if you are unsure.", NOTE)

    c = r + 5
    put(ws, f"A{c}", "Your capacity", BOLD)
    put(ws, f"A{c + 1}", "Working days per month")
    put(ws, f"B{c + 1}", 20, fill=INPUT)
    put(ws, f"A{c + 2}", "Working hours per day")
    put(ws, f"B{c + 2}", 8, fill=INPUT)
    put(ws, f"A{c + 3}", "Share of hours you can bill to clients")
    put(ws, f"B{c + 3}", 0.5, fill=INPUT, fmt=PCT)
    put(ws, f"C{c + 3}", "The rest goes on finding clients, admin, learning and proposals that do not convert.", NOTE)
    put(ws, f"A{c + 4}", "Billable hours per month", BOLD)
    put(ws, f"B{c + 4}", f"=B{c + 1}*B{c + 2}*B{c + 3}", BOLD, RESULT, "0")

    m = c + 6
    put(ws, f"A{m}", "Revenue you need each month", BOLD)
    put(ws, f"B{m}", f"=IFERROR((B{last + 1}+B{r + 1})*(1+B{r + 2})/(1-B{r + 3}),0)", BOLD, RESULT, GHS0)
    put(ws, f"A{m + 1}", "Your minimum hourly rate (your floor)", BOLD)
    put(ws, f"B{m + 1}", f"=IFERROR(B{m}/B{c + 4},0)", Font(name="Arial", bold=True, size=13, color=INK), RESULT, GHS)
    put(ws, f"C{m + 1}", "Below this rate, every hour you sell loses money. It is a floor, not your price.", NOTE)
    floor_ref = f"'1 Your costs'!B{m + 1}"

    # ---------------------------------------------------------- 2 Project estimate
    ws = sheet(wb, "2 Project estimate", {"A": 50, "B": 14, "C": 60})
    put(ws, "A1", "2. Project estimate", HEAD)
    legend(ws, 2)
    put(ws, "A3", "Project")
    put(ws, "B3", "Order intake automation for a wholesaler (example)", fill=INPUT)
    ws.merge_cells("B3:C3")
    put(ws, "A5", "Phase", BOLD)
    put(ws, "B5", "Hours", BOLD)
    put(ws, "C5", "What to count", BOLD)
    phases = [
        ("Discovery and requirements", 6, "Meetings, process mapping, reading their systems"),
        ("Solution design", 4, "Workflow design, data model, error handling plan"),
        ("Build", 16, "The automation itself"),
        ("Integrations, accounts and credentials", 5, "API access, permissions, test accounts, waiting on the client"),
        ("Testing", 8, "Normal cases, edge cases, failures, duplicates; plan about half the build time"),
        ("Revisions", 5, "Changes after the client sees it working"),
        ("Documentation and handover", 4, "How it works, how to restart it, who to call"),
        ("Training the client's team", 2, ""),
        ("Project management and communication", 4, "Updates, calls, messages; often forgotten"),
    ]
    for i, (name, hours, note) in enumerate(phases, start=6):
        put(ws, f"A{i}", name)
        put(ws, f"B{i}", hours, fill=INPUT)
        put(ws, f"C{i}", note, NOTE)
    pl = 5 + len(phases)
    put(ws, f"A{pl + 1}", "Estimated hours", BOLD)
    put(ws, f"B{pl + 1}", f"=SUM(B6:B{pl})", BOLD, RESULT, "0")

    k = pl + 3
    put(ws, f"A{k}", "Risk", BOLD)
    put(ws, f"A{k + 1}", "Project risk level (Low, Medium or High)")
    put(ws, f"B{k + 1}", "Medium", fill=INPUT)
    dv = DataValidation(type="list", formula1='"Low,Medium,High"', allow_blank=False)
    ws.add_data_validation(dv)
    dv.add(f"B{k + 1}")
    put(ws, f"C{k + 1}", "High: an unfamiliar system, an API you have not used, unclear requirements, many people to agree.", NOTE)
    put(ws, f"A{k + 2}", "Contingency for Low / Medium / High risk")
    put(ws, f"B{k + 2}", "see right", NOTE)
    put(ws, f"D{k + 1}", "Low")
    put(ws, f"E{k + 1}", 0.10, fill=INPUT, fmt=PCT)
    put(ws, f"D{k + 2}", "Medium")
    put(ws, f"E{k + 2}", 0.20, fill=INPUT, fmt=PCT)
    put(ws, f"D{k + 3}", "High")
    put(ws, f"E{k + 3}", 0.35, fill=INPUT, fmt=PCT)
    put(ws, f"A{k + 3}", "Contingency applied")
    put(ws, f"B{k + 3}", f"=VLOOKUP(B{k + 1},D{k + 1}:E{k + 3},2,FALSE)", fill=RESULT, fmt=PCT)
    put(ws, f"A{k + 4}", "Hours including contingency", BOLD)
    put(ws, f"B{k + 4}", f"=B{pl + 1}*(1+B{k + 3})", BOLD, RESULT, "0.0")

    s = k + 6
    put(ws, f"A{s}", "Support and costs you pay during the project", BOLD)
    put(ws, f"A{s + 1}", "Support included after handover (months)")
    put(ws, f"B{s + 1}", 1, fill=INPUT)
    put(ws, f"A{s + 2}", "Support hours per month")
    put(ws, f"B{s + 2}", 2, fill=INPUT)
    put(ws, f"A{s + 3}", "Tools, API usage or hosting you pay for this project (GHS)")
    put(ws, f"B{s + 3}", 300, fill=INPUT, fmt=GHS0)
    put(ws, f"C{s + 3}", "If the client pays these directly, enter 0 and list them in the quote instead.", NOTE)
    put(ws, f"A{s + 4}", "Profit margin on top of cost")
    put(ws, f"B{s + 4}", 0.20, fill=INPUT, fmt=PCT)
    put(ws, f"C{s + 4}", "Margin is what lets you invest, take time off and absorb a project that goes wrong.", NOTE)

    p = s + 6
    put(ws, f"A{p}", "Your floor rate (from sheet 1)")
    put(ws, f"B{p}", f"={floor_ref}", fill=RESULT, fmt=GHS)
    put(ws, f"A{p + 1}", "Cost of delivering this project", BOLD)
    put(ws, f"B{p + 1}", f"=(B{k + 4}+B{s + 1}*B{s + 2})*B{p}+B{s + 3}", BOLD, RESULT, GHS0)
    put(ws, f"C{p + 1}", "What the project costs you. Quoting below this loses money.", NOTE)
    put(ws, f"A{p + 2}", "Hourly price (rate with margin x hours)", BOLD)
    put(ws, f"B{p + 2}", f"=CEILING((B{k + 4}+B{s + 1}*B{s + 2})*B{p}*(1+B{s + 4})+B{s + 3},50)", BOLD, RESULT, GHS0)
    put(ws, f"A{p + 3}", "Fixed-project price", BOLD)
    put(ws, f"B{p + 3}", f"=CEILING(B{p + 1}*(1+B{s + 4}),50)", Font(name="Arial", bold=True, size=13, color=INK), RESULT, GHS0)
    put(ws, f"C{p + 3}", "Rounded up to the nearest GHS 50. The client pays this whatever the hours, so the risk is yours.", NOTE)
    cost_ref = f"'2 Project estimate'!B{p + 1}"
    hourly_ref = f"'2 Project estimate'!B{p + 2}"
    fixed_ref = f"'2 Project estimate'!B{p + 3}"

    # -------------------------------------------------------------- 3 Value check
    ws = sheet(wb, "3 Value check", {"A": 56, "B": 16, "C": 60})
    put(ws, "A1", "3. Value check: what the problem costs the client", HEAD)
    legend(ws, 2)
    put(ws, "A4", "Time spent on the task today", BOLD)
    put(ws, "A5", "Staff hours per week spent on it")
    put(ws, "B5", 15, fill=INPUT)
    put(ws, "A6", "Cost of one staff hour to the business (GHS)")
    put(ws, "B6", 25, fill=INPUT, fmt=GHS)
    put(ws, "C6", "Ask the client. If they will not say, estimate from monthly pay divided by hours worked.", NOTE)
    put(ws, "A7", "Annual cost of that time")
    put(ws, "B7", "=B5*B6*52", fill=RESULT, fmt=GHS0)
    put(ws, "A9", "Errors and missed revenue", BOLD)
    put(ws, "A10", "Errors per month (wrong orders, missed follow-ups)")
    put(ws, "B10", 4, fill=INPUT)
    put(ws, "A11", "Average cost of one error (GHS)")
    put(ws, "B11", 300, fill=INPUT, fmt=GHS0)
    put(ws, "A12", "Revenue lost per year to slow or missed responses (GHS)")
    put(ws, "B12", 6000, fill=INPUT, fmt=GHS0)
    put(ws, "A13", "Annual cost of errors and missed revenue")
    put(ws, "B13", "=B10*B11*12+B12", fill=RESULT, fmt=GHS0)
    put(ws, "A15", "Annual cost of the problem", BOLD)
    put(ws, "B15", "=B7+B13", BOLD, RESULT, GHS0)
    put(ws, "A16", "Share of that cost the automation realistically removes")
    put(ws, "B16", 0.6, fill=INPUT, fmt=PCT)
    put(ws, "C16", "Be conservative. Clients trust a modest, defensible number more than a big one.", NOTE)
    put(ws, "A17", "First-year value to the client", BOLD)
    put(ws, "B17", "=B15*B16", BOLD, RESULT, GHS0)
    put(ws, "A19", "Your fixed-project price (from sheet 2)")
    put(ws, "B19", f"={fixed_ref}", fill=RESULT, fmt=GHS0)
    put(ws, "A20", "Price as a share of first-year value")
    put(ws, "B20", "=IFERROR(B19/B17,0)", fill=RESULT, fmt=PCT)
    put(ws, "A21", "Months for the client to recover the price")
    put(ws, "B21", "=IFERROR(B19/(B17/12),0)", fill=RESULT, fmt="0.0")
    put(ws, "A23", "Reading it", BOLD)
    put(ws, "A24", "If the price is more than the first-year value, the project is hard for the client to justify: reduce scope, phase it, or walk away.", BODY)
    put(ws, "A25", "If the price is a small share of a large value, you may be underpricing. Value-informed pricing means the value supports a higher price, not that you charge the value.", BODY)
    put(ws, "A26", "Payback in months is often the clearest way to explain your price to a business owner.", BODY)
    for row in (24, 25, 26):
        ws.merge_cells(f"A{row}:C{row}")
        ws[f"A{row}"].alignment = Alignment(wrap_text=True, vertical="top")
        ws.row_dimensions[row].height = 30

    # ------------------------------------------------------------ 4 Price decision
    ws = sheet(wb, "4 Price decision", {"A": 50, "B": 18, "C": 60})
    put(ws, "A1", "4. Price decision", HEAD)
    legend(ws, 2)
    put(ws, "A4", "Approach", BOLD)
    put(ws, "B4", "Price (GHS)", BOLD)
    put(ws, "C4", "Use it when", BOLD)
    put(ws, "A5", "Cost of delivery (your floor for this project)")
    put(ws, "B5", f"={cost_ref}", fill=RESULT, fmt=GHS0)
    put(ws, "C5", "Never quote below this.", NOTE)
    put(ws, "A6", "Hourly")
    put(ws, "B6", f"={hourly_ref}", fill=RESULT, fmt=GHS0)
    put(ws, "C6", "The scope is unclear or keeps changing, or the work is ongoing support.", NOTE)
    put(ws, "A7", "Fixed project")
    put(ws, "B7", f"={fixed_ref}", fill=RESULT, fmt=GHS0)
    put(ws, "C7", "The scope is clear and written down, with exclusions and a change-request process.", NOTE)
    put(ws, "A8", "Value-informed ceiling (share of first-year value)")
    put(ws, "B8", "='3 Value check'!B17*B9", fill=RESULT, fmt=GHS0)
    put(ws, "C8", "The client has a measurable problem and you can show the numbers.", NOTE)
    put(ws, "A9", "Share of first-year value you consider fair to charge")
    put(ws, "B9", 0.5, fill=INPUT, fmt=PCT)
    put(ws, "C9", "A judgement call. A lower share makes the decision easy for the client.", NOTE)
    put(ws, "A11", "The price you will quote", BOLD)
    put(ws, "B11", 5000, Font(name="Arial", bold=True, size=13, color=INK), INPUT, GHS0)
    put(ws, "C11", "The example is deliberately low, the number many practitioners would guess, so you can see the check below catch it.", NOTE)
    put(ws, "A12", "Check", BOLD)
    put(ws, "B12", '=IF(B11<B5,"Below your cost: you lose money on this project",IF(B11>MAX(B7,B8),"Above both your fixed price and the value ceiling: be ready to justify it","Within a defensible range"))', BOLD, RESULT)
    ws.merge_cells("B12:C12")
    put(ws, "A13", "Profit on this project at that price")
    put(ws, "B13", "=B11-B5", fill=RESULT, fmt=GHS0)
    put(ws, "A15", "Payment schedule", BOLD)
    put(ws, "A16", "Deposit before work starts")
    put(ws, "B16", 0.5, fill=INPUT, fmt=PCT)
    put(ws, "A17", "Deposit amount")
    put(ws, "B17", "=ROUND(B11*B16,0)", fill=RESULT, fmt=GHS0)
    put(ws, "A18", "Balance on acceptance")
    put(ws, "B18", "=B11-B17", fill=RESULT, fmt=GHS0)
    put(ws, "C16", "A deposit commits the client and covers your early costs if the project stops.", NOTE)
    put(ws, "A20", "Explain your price in two sentences", BOLD)
    put(ws, "A21", "This covers [what you deliver, including testing, handover and support]. It costs about [payback] months of what the problem costs you today.", fill=INPUT)
    ws.merge_cells("A21:C21")
    ws["A21"].alignment = Alignment(wrap_text=True, vertical="top")
    ws.row_dimensions[21].height = 36

    # ------------------------------------------------------------- 5 Pricing clinic
    ws = sheet(wb, "5 Pricing clinic", {"A": 110})
    put(ws, "A1", "5. Pricing clinic: practice projects", HEAD)
    put(ws, "A2", "Fictional businesses, written for practice. Price one of them with sheets 2 to 4, then explain your price to a partner in two minutes.", NOTE)
    clinic = [
        ("Project A: order intake for a wholesaler in Kumasi", BOLD),
        ("A fabric wholesaler takes about 40 orders a day from shop owners on WhatsApp. Two staff copy each order into a spreadsheet, check stock, then type an invoice and send it back by WhatsApp. It takes them around three hours a day between them, and about four orders a month go out wrong, each costing roughly GHS 300 in returns and goodwill.", BODY),
        ("The owner wants orders captured once, stock checked automatically, an invoice sent within minutes, and a daily summary. They already use Google Sheets and a mobile money merchant account. They have never worked with a freelancer before and are price-sensitive.", BODY),
        ("Questions: What will you include and exclude? What are the risks (WhatsApp access, messy order formats, staff adoption)? Hourly or fixed? How long is support? What is the payback for the owner?", NOTE),
        ("", BODY),
        ("Project B: appointment reminders for a clinic group in Accra", BOLD),
        ("A private clinic with three branches books appointments by phone and records them in a practice management system that has an API. Missed appointments are frequent. The manager wants SMS and WhatsApp reminders 24 hours and 2 hours before each appointment, a way for patients to confirm or cancel, and a weekly report of no-shows.", BODY),
        ("Questions: Patient data is sensitive. How does that change your scope, testing and price? Who signs off? What happens when the clinic's system is down?", NOTE),
        ("", BODY),
        ("Project C: lead routing for an overseas client, priced in US dollars", BOLD),
        ("A small marketing agency abroad receives enquiries through a website form and two ad platforms. Leads sit in an inbox for a day before anyone replies. They want each lead enriched, scored, routed to the right account manager in their CRM and acknowledged by email within five minutes.", BODY),
        ("Work out your price in cedis first, then convert at today's exchange rate. Questions: How do time zones affect delivery and support? Which payment method and currency will you ask for? What does the client compare you against?", NOTE),
        ("Today's exchange rate, GHS per US dollar (enter it yourself):", BOLD),
    ]
    for i, (text, font) in enumerate(clinic, start=4):
        put(ws, f"A{i}", text, font, wrap=True)
        if font is BODY and text:
            ws.row_dimensions[i].height = 48
    last_row = 3 + len(clinic)
    rate_row = last_row + 1
    put(ws, f"A{rate_row}", None, fill=INPUT, fmt="0.00")
    put(ws, f"A{rate_row + 1}", "Your price in US dollars = your GHS price (sheet 4) divided by this rate:", NOTE)
    put(ws, f"A{rate_row + 2}", f"=IFERROR(ROUND('4 Price decision'!B11/A{rate_row},0),\"Enter today's rate above\")", BOLD, RESULT, '"USD "#,##0')

    # ----------------------------------------------------------- 6 Pricing mistakes
    ws = sheet(wb, "6 Pricing mistakes", {"A": 44, "B": 70})
    put(ws, "A1", "6. Pricing mistakes and the fix for each", HEAD)
    put(ws, "A3", "Mistake", BOLD)
    put(ws, "B3", "Fix", BOLD)
    mistakes = [
        ("Pricing only the build hours", "Count discovery, testing, revisions, handover, training and communication. They often equal the build itself."),
        ("Using an employee's hourly pay as your rate", "Your rate must cover unbillable time, equipment, software, power, data, tax and slow months. Sheet 1 shows the gap."),
        ("Matching the cheapest quote", "Compete on the problem you solve and the risk you remove, not on price. Explain what the cheaper quote leaves out."),
        ("A fixed price with no written scope", "Fix the price only after deliverables, exclusions and acceptance criteria are written down and agreed."),
        ("No allowance for risk", "Add contingency for unfamiliar systems, unclear requirements and clients you have not worked with."),
        ("Free support for ever", "State what support is included and for how long, and price ongoing support separately."),
        ("Starting without a deposit", "Ask for a deposit before work starts. It filters out clients who are not committed."),
        ("Charging the full value to the client", "Value supports a higher price; it does not set it. Leave the client a clear return."),
        ("Quoting a number with no explanation", "Give the price with what it covers and the payback, in plain language."),
        ("Overpricing to look premium", "A price you cannot explain loses the client. Every part of the price should trace back to cost, risk or value."),
    ]
    for i, (a, b) in enumerate(mistakes, start=4):
        put(ws, f"A{i}", a, BOLD, wrap=True)
        put(ws, f"B{i}", b, wrap=True)
        ws.row_dimensions[i].height = 32

    for w in wb.worksheets:
        w.sheet_properties.tabColor = "0B6B4A" if w.title != "Read me" else "9A4E12"
    out = HERE / "pricing-worksheet.xlsx"
    wb.save(out)
    return out


def build_quotation():
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Arial"
    style.font.size = Pt(10.5)

    def h(text, level=1):
        p = doc.add_heading(text, level=level)
        for run in p.runs:
            run.font.color.rgb = RGBColor(0x0E, 0x1A, 0x15)
        return p

    def guide(text):
        p = doc.add_paragraph()
        r = p.add_run(text)
        r.italic = True
        r.font.size = Pt(9)
        r.font.color.rgb = RGBColor(0x52, 0x61, 0x5B)
        return p

    def table(rows, widths=None, header=True):
        t = doc.add_table(rows=len(rows), cols=len(rows[0]))
        t.style = "Table Grid"
        for i, row in enumerate(rows):
            for j, val in enumerate(row):
                cell = t.cell(i, j)
                cell.text = val
                if header and i == 0:
                    for run in cell.paragraphs[0].runs:
                        run.bold = True
        doc.add_paragraph()
        return t

    title = doc.add_heading("Project quotation", 0)
    for run in title.runs:
        run.font.color.rgb = RGBColor(0x0E, 0x1A, 0x15)
    guide("Template from Get Paid for Automation, workshop 01. Replace everything in square brackets, delete these grey notes, and send it as a PDF.")

    table([
        ["From", "[Your name or business name], [email], [phone or WhatsApp]"],
        ["To", "[Client contact name], [business name]"],
        ["Quotation number", "[Q-0001]"],
        ["Date", "[date]"],
        ["Valid until", "[date, usually 14 to 30 days]"],
    ], header=False)

    h("1. The problem")
    guide("In the client's words, what is going wrong and what it costs them. One short paragraph. Use the figures from your value check.")
    doc.add_paragraph("[Today, your team spends about [hours] a week [task]. This leads to [errors / delays / lost sales], costing roughly [amount] a year.]")

    h("2. What we will deliver")
    guide("The outcome first, then the deliverables. Name the tools only where the client needs to know.")
    doc.add_paragraph("[When this is complete, [outcome in plain language].]")
    for item in ["[Deliverable 1: e.g. orders received on WhatsApp are captured in your stock sheet automatically]",
                 "[Deliverable 2]", "[Deliverable 3]", "Testing against the acceptance criteria in section 6",
                 "Documentation: how it works, how to restart it, and who to contact",
                 "[Number]-hour handover and training session for [who]"]:
        doc.add_paragraph(item, style="List Bullet")

    h("3. Not included")
    guide("Exclusions prevent most disputes. List what a reasonable client might assume is included but is not.")
    for item in ["[e.g. changes to your website]", "[e.g. third-party subscription fees, which you pay directly]",
                 "[e.g. data clean-up of existing records]", "New features requested after acceptance (see section 8)"]:
        doc.add_paragraph(item, style="List Bullet")

    h("4. Assumptions and your responsibilities")
    for item in ["[You will provide access to [systems] by [date]]", "[A named person on your side will answer questions within [number] working days]",
                 "[Your [system] has an API we can use; if not, the approach and price will be reviewed]"]:
        doc.add_paragraph(item, style="List Bullet")

    h("5. Timeline")
    table([
        ["Stage", "What happens", "Target date"],
        ["Start", "Deposit received, access provided, kick-off call", "[date]"],
        ["Build and test", "[summary]", "[date]"],
        ["Review", "You test it and request revisions (up to [number] rounds)", "[date]"],
        ["Handover", "Documentation and training", "[date]"],
    ])

    h("6. Acceptance")
    guide("How both sides will know the work is finished. Make each one testable.")
    for item in ["[e.g. 20 test orders processed with no manual typing]", "[e.g. invoices sent within 5 minutes of an order]",
                 "[e.g. failures alert [name] by email]"]:
        doc.add_paragraph(item, style="List Bullet")

    h("7. Fees and payment")
    table([
        ["Item", "Description", "Amount (GHS)"],
        ["Project fee", "Design, build, testing, documentation and handover as described above", "[amount]"],
        ["Support", "[number] month(s) of support after handover, up to [hours] hours a month", "[included / amount]"],
        ["Total", "", "[total]"],
    ])
    table([
        ["Payment", "When", "Amount (GHS)"],
        ["Deposit ([percent]%)", "Before work starts", "[amount]"],
        ["Balance", "On acceptance", "[amount]"],
    ])
    doc.add_paragraph("Payment by [mobile money / bank transfer / card] to [account details]. Invoices are due within [number] days.")
    guide("For an overseas client, state the currency (for example USD), who pays transfer fees, and the payment method.")

    h("8. Changes, revisions and support")
    for item in ["Up to [number] rounds of revisions within the scope above are included.",
                 "Changes outside the scope are quoted separately in writing before any work is done, at [rate] per hour or a fixed price.",
                 "After the support period, ongoing support is available at [rate / monthly fee].",
                 "We are not responsible for failures caused by changes to third-party services, but will quote to fix them."]:
        doc.add_paragraph(item, style="List Bullet")

    h("9. Agreement")
    doc.add_paragraph("To accept this quotation, sign below or reply in writing, and pay the deposit.")
    table([
        ["", "Client", "Provider"],
        ["Name", "", ""],
        ["Signature", "", ""],
        ["Date", "", ""],
    ])

    out = HERE / "quotation-template.docx"
    doc.save(out)
    return out


if __name__ == "__main__":
    for path in (build_workbook(), build_quotation()):
        print("wrote", path.name)
