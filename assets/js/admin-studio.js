/* Certificate Issuance Studio: the existing administrator session, server-authorized
 * operations, explicit issuance/email/handout approval, no signature in frontend. */
(function () {
  "use strict";
  var root = document.getElementById("certificate-studio"),
    body = document.getElementById("studio-body"),
    message = document.getElementById("studio-message");
  var model = {},
    course = null,
    cohort = null,
    batch = null,
    stage = 1,
    deliveryMethod = "later",
    busy = false,
    urls = [];
  var emailSubject =
    "Congratulations! Your Bulletproof Automations Certificate of Completion";
  var emailBody =
    "Dear {{first_name}},\n\nCongratulations on successfully completing {{course}}!\n\nYour Certificate of Completion is attached. Your course ran from {{start_date}} through {{end_date}}.\n\nCertificate ID: {{credential_id}}\nIssue date: {{issue_date}}\nVerification link: {{url}}\n\nYou may share your unique verification link with prospective employers, recruiters and clients, and add your certificate to LinkedIn under Licenses & Certifications.\n\nWarm regards,\n\nJohnathan Lightfoot\nFounder, Bulletproof Automations\njohnathan@bulletproofautomations.com";
  function el(tag, text, parent, cls) {
    var n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }
  function button(text, fn, parent) {
    var b = el("button", text, parent || body, "mini");
    b.type = "button";
    b.addEventListener("click", function () {
      run(fn);
    });
    return b;
  }
  function report(text, bad) {
    message.textContent = text;
    message.className = bad ? "msg msg--bad" : "msg";
    message.hidden = !text;
  }
  async function api(action, data, binary) {
    var r = await authFetch("/functions/v1/certificate-studio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: action, data: data || {} }),
    });
    if (!r.ok) {
      var error = await r.json();
      throw Error(error.error || "Studio request failed");
    }
    return binary ? r.blob() : r.json();
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    try {
      await fn();
    } catch (e) {
      report(e.message, true);
    } finally {
      busy = false;
      root.setAttribute("aria-busy", "false");
    }
  }
  async function reload() {
    model = await api("list");
    if (batch)
      batch = model.batches.find(function (b) {
        return b.id === batch.id;
      });
    render();
  }
  function field(parent, label, value, type) {
    var box = el("div", undefined, parent, "fld"),
      id = "studio-field-" + Math.random().toString(36).slice(2);
    var l = el("label", label, box);
    l.htmlFor = id;
    var input = el(type === "textarea" ? "textarea" : "input", undefined, box);
    input.id = id;
    if (type !== "textarea") input.type = type || "text";
    input.value = value || "";
    return input;
  }
  function select(parent, label, items, current) {
    var s = field(parent, label, "");
    var sel = document.createElement("select");
    sel.id = s.id;
    s.replaceWith(sel);
    items.forEach(function (i) {
      var o = el("option", i.label, sel);
      o.value = i.id;
    });
    sel.value = current || "";
    return sel;
  }
  function check(parent, label, value) {
    var box = el("div", undefined, parent, "fld fld--check"),
      i = el("input", undefined, box);
    i.type = "checkbox";
    i.id = "studio-check-" + Math.random().toString(36).slice(2);
    i.checked = !!value;
    var l = el("label", label, box);
    l.htmlFor = i.id;
    return i;
  }
  function graduates() {
    return (model.graduates || []).filter(function (g) {
      return batch && g.batch_id === batch.id;
    });
  }
  function save(blob, name) {
    var u = URL.createObjectURL(blob);
    setTimeout(function () {
      URL.revokeObjectURL(u);
    }, 30000);
    var a = el("a", undefined, document.body);
    a.href = u;
    a.download = name;
    a.click();
    a.remove();
  }
  function next(n) {
    stage = n;
    render();
  }
  function render() {
    body.replaceChildren();
    urls.splice(0).forEach(function (u) {
      URL.revokeObjectURL(u);
    });
    var nav = el("nav", undefined, body, "studio-steps");
    nav.setAttribute("aria-label", "Certificate creation steps");
    [
      "Course",
      "Cohort",
      "Graduates",
      "Draft proofs",
      "Approve & issue",
      "Delivery",
      "Report",
    ].forEach(function (t, i) {
      var b = button(
        i + 1 + ". " + t,
        function () {
          next(i + 1);
        },
        nav,
      );
      if (stage === i + 1) b.setAttribute("aria-current", "step");
    });
    if (stage > 2 && !batch) {
      el("p", "Select or create an issuance batch in step 2.", body);
      return;
    }
    if (batch && stage > 2)
      el(
        "p",
        batch.snapshot.course_name +
          " · " +
          batch.snapshot.cohort_name +
          " · " +
          batch.state +
          " · revision " +
          batch.revision,
        body,
        "studio-context",
      );
    if (stage === 1) courses();
    if (stage === 2) cohorts();
    if (stage === 3) roster();
    if (stage === 4) proofs();
    if (stage === 5) issuance();
    if (stage === 6) delivery();
    if (stage === 7) results();
  }
  function courses() {
    el("h3", "1. Select or configure a course", body);
    var choices = select(
      body,
      "Course",
      [{ id: "", label: "Create a new course" }].concat(
        model.courses.map(function (c) {
          return { id: c.id, label: c.data.name + " (" + c.data.status + ")" };
        }),
      ),
      course && course.id,
    );
    choices.addEventListener("change", function () {
      course =
        model.courses.find(function (c) {
          return c.id === choices.value;
        }) || null;
      cohort = null;
      render();
    });
    var c = course ? course.data : {},
      name = field(body, "Course name", c.name),
      code = field(body, "Course code", c.code),
      level = field(
        body,
        "Level (Beginner, Intermediate, Advanced or custom)",
        c.level || "Beginner",
      ),
      description = field(
        body,
        "Course description",
        c.description,
        "textarea",
      ),
      title = field(
        body,
        "Certificate title",
        c.certificate_title || "Certificate of Completion",
      ),
      requirements = field(
        body,
        "Completion requirements",
        c.requirements,
        "textarea",
      ),
      statement = field(
        body,
        "Default completion statement",
        c.statement || "for successfully completing the training program",
        "textarea",
      );
    el(
      "p",
      "Template 001 — Bulletproof Automations Signature Certificate (version 1). Completion certificates only; BCAB and BCAE require their separate assessment process.",
      body,
    );
    var status = select(
      body,
      "Status",
      [
        { id: "active", label: "Active" },
        { id: "archived", label: "Archived" },
      ],
      c.status || "active",
    );
    var subject = field(
        body,
        "Email subject template",
        c.email_subject || emailSubject,
      ),
      content = field(
        body,
        "Email message template",
        c.email_body || emailBody,
        "textarea",
      );
    el(
      "p",
      "Personalization: {{name}}, {{first_name}}, {{course}}, {{start_date}}, {{end_date}}, {{issue_date}}, {{credential_id}}, {{url}}.",
      body,
    );
    button("Save course", async function () {
      var saved = await api("course", {
        id: course && course.id,
        course: {
          name: name.value,
          code: code.value,
          level: level.value,
          description: description.value,
          certificate_title: title.value,
          requirements: requirements.value,
          statement: statement.value,
          status: status.value,
          template: "001",
          email_subject: subject.value,
          email_body: content.value,
        },
      });
      model = await api("list");
      course = model.courses.find(function (x) {
        return x.id === saved.id;
      });
      report("Course saved.");
      next(2);
    });
    if (course)
      button("Use this course →", function () {
        next(2);
      });
  }
  function cohorts() {
    el("h3", "2. Choose the class session", body);
    if (!course) {
      el("p", "Select a course first.", body);
      button("Choose course", function () {
        next(1);
      });
      return;
    }
    var items = model.cohorts.filter(function (h) {
      return h.course_id === course.id;
    });
    var chooser = select(
      body,
      "Cohort",
      [{ id: "", label: "Create a new cohort" }].concat(
        items.map(function (h) {
          return { id: h.id, label: h.data.name };
        }),
      ),
      cohort && cohort.id,
    );
    chooser.addEventListener("change", function () {
      cohort =
        items.find(function (h) {
          return h.id === chooser.value;
        }) || null;
      render();
    });
    if (!cohort) {
      var name = field(body, "Cohort name", ""),
        start = field(body, "First session date", "", "date"),
        end = field(body, "Last session date", "", "date"),
        teacher = field(body, "Instructor", "Johnathan Lightfoot");
      button("Save cohort", async function () {
        var r = await api("cohort", {
          course_id: course.id,
          cohort: {
            name: name.value,
            start_date: start.value,
            end_date: end.value,
            instructor: teacher.value,
          },
        });
        model = await api("list");
        cohort = model.cohorts.find(function (h) {
          return h.id === r.id;
        });
        render();
      });
    } else {
      el(
        "p",
        cohort.data.start_date +
          " to " +
          cohort.data.end_date +
          " · " +
          cohort.data.instructor,
        body,
      );
      var edit = el("details", undefined, body);
      el("summary", "Edit cohort configuration", edit);
      var editName = field(edit, "Updated cohort name", cohort.data.name),
        editStart = field(
          edit,
          "Updated first session date",
          cohort.data.start_date,
          "date",
        ),
        editEnd = field(
          edit,
          "Updated last session date",
          cohort.data.end_date,
          "date",
        ),
        editInstructor = field(
          edit,
          "Updated instructor",
          cohort.data.instructor,
        ),
        editReason = field(edit, "Reason for cohort changes", "");
      button(
        "Save cohort changes",
        async function () {
          await api("update_cohort", {
            id: cohort.id,
            reason: editReason.value,
            cohort: {
              name: editName.value,
              start_date: editStart.value,
              end_date: editEnd.value,
              instructor: editInstructor.value,
            },
          });
          model = await api("list");
          cohort = model.cohorts.find(function (h) {
            return h.id === cohort.id;
          });
          report(
            "Cohort saved. Approved certificates and batch snapshots retain their original details.",
          );
          render();
        },
        edit,
      );
      var issue = field(
          body,
          "Certificate issue date",
          cohort.data.end_date,
          "date",
        ),
        reason = field(
          body,
          "Audit reason (required if issue date changes)",
          "",
        );
      button("Create issuance batch →", async function () {
        var r = await api("batch", {
          cohort_id: cohort.id,
          issue_date: issue.value,
          reason: reason.value,
        });
        model = await api("list");
        batch = model.batches.find(function (b) {
          return b.id === r.id;
        });
        next(3);
      });
    }
    el("h3", "Resume a saved batch", body);
    model.batches.forEach(function (b) {
      button(
        b.snapshot.course_name +
          " · " +
          b.snapshot.cohort_name +
          " · " +
          b.state,
        function () {
          batch = b;
          cohort = model.cohorts.find(function (h) {
            return h.id === b.cohort_id;
          });
          course = model.courses.find(function (c) {
            return c.id === cohort.course_id;
          });
          next(b.state === "draft" ? 3 : 6);
        },
      );
    });
  }
  function roster() {
    el("h3", "3. Add graduates and approve eligibility", body);
    if (batch.state !== "draft") {
      el(
        "p",
        "Issuance already approved. Use a correction to change an issued certificate.",
        body,
      );
      return;
    }
    el(
      "p",
      "Completion approval is independent of payment and enrollment status. Publication and name search require separate consent.",
      body,
    );
    var box = el("div", undefined, body, "studio-grid"),
      manual = el("div", undefined, box),
      enrolled = el("div", undefined, box);
    el("h4", "Manual entry", manual);
    var name = field(manual, "Exact full name", ""),
      email = field(manual, "Email (optional for print-only)", "", "email"),
      pub = check(manual, "Graduate consents to public verification", false),
      lookup = check(manual, "Graduate consents to name lookup", false);
    button(
      "Add graduate",
      async function () {
        await api("graduates", {
          batch_id: batch.id,
          graduates: [
            {
              full_name: name.value,
              email: email.value,
              publish_consent: pub.checked,
              allow_name_lookup: lookup.checked,
            },
          ],
        });
        await reload();
      },
      manual,
    );
    el("h4", "Select from enrollments", enrolled);
    var choice = select(
      enrolled,
      "Enrolled student",
      model.enrollments.map(function (e) {
        return { id: e.id, label: e.full_name + " · " + e.email };
      }),
    );
    button(
      "Add selected student",
      async function () {
        var e = model.enrollments.find(function (x) {
          return x.id === choice.value;
        });
        if (!e) throw Error("Choose a student");
        await api("graduates", {
          batch_id: batch.id,
          graduates: [
            { full_name: e.full_name, email: e.email, enrollment_id: e.id },
          ],
        });
        await reload();
      },
      enrolled,
    );
    var csv = field(
      body,
      "CSV file (full_name,email; consent remains off)",
      "",
      "file",
    );
    csv.accept = ".csv,text/csv";
    button("Validate & import CSV", async function () {
      if (!csv.files[0]) throw Error("Choose a CSV");
      await api("import_csv", {
        batch_id: batch.id,
        csv: await csv.files[0].text(),
      });
      await reload();
    });
    graduates().forEach(function (g) {
      var card = el("article", undefined, body, "studio-card");
      el("h4", g.data.full_name, card);
      el("p", g.data.email || "Print-only: no email", card);
      var eligible = check(card, "Approve completion eligibility", g.eligible);
      eligible.addEventListener("change", function () {
        run(async function () {
          await api("eligibility", {
            batch_id: batch.id,
            id: g.id,
            eligible: eligible.checked,
          });
          await reload();
        });
      });
      button(
        "Remove from draft roster",
        async function () {
          await api("remove_graduate", { batch_id: batch.id, id: g.id });
          await reload();
        },
        card,
      );
      button(
        "Correct draft details",
        async function () {
          var n = window.prompt("Exact full name", g.data.full_name);
          if (n === null) return;
          var e = window.prompt("Email (blank allowed)", g.data.email || "");
          if (e === null) return;
          var consent = window.confirm(
            "Has this graduate consented to public verification?",
          );
          var lookupConsent =
            consent &&
            window.confirm("Has this graduate consented to name lookup?");
          await api("graduate", {
            batch_id: batch.id,
            id: g.id,
            graduate: {
              full_name: n,
              email: e,
              enrollment_id: g.data.enrollment_id,
              publish_consent: consent,
              allow_name_lookup: lookupConsent,
            },
          });
          await reload();
        },
        card,
      );
    });
    button("Review draft proofs →", function () {
      next(4);
    });
  }
  function proofs() {
    el("h3", "4. Review actual PDF proofs", body);
    el(
      "p",
      "Generate and inspect every proof. Drafts are unsigned and cannot be publicly verified. Roster changes invalidate earlier reviews.",
      body,
    );
    var gallery = el("div", undefined, body, "studio-gallery");
    graduates().forEach(function (g) {
      var card = el("article", undefined, gallery, "studio-card");
      el("h4", g.data.full_name, card);
      el("p", g.eligible ? "Eligible" : "Eligibility approval required", card);
      button(
        "Generate preview",
        async function () {
          var blob = await api("proof", { id: g.id, preview: true }, true),
            u = URL.createObjectURL(blob);
          urls.push(u);
          var img = el("img", undefined, card, "studio-proof");
          img.alt = "DRAFT certificate proof for " + g.data.full_name;
          img.src = u;
          report("Inspect the layout, then mark this proof reviewed.");
        },
        card,
      );
      button(
        "Download PDF proof",
        async function () {
          save(
            await api("proof", { id: g.id }, true),
            "DRAFT-" + g.id + ".pdf",
          );
        },
        card,
      );
      button(
        g.reviewed_revision === batch.revision
          ? "Reviewed ✓"
          : "Mark proof reviewed",
        async function () {
          await api("review", {
            batch_id: batch.id,
            id: g.id,
            revision: batch.revision,
          });
          await reload();
        },
        card,
      );
    });
    button("Continue to issuance →", function () {
      next(5);
    });
  }
  function issuance() {
    el("h3", "5. Approve & issue certificates", body);
    el(
      "p",
      "Approval authorizes the institutional signature. It creates no email and does not mark certificates handed out.",
      body,
    );
    var all = graduates();
    el(
      "p",
      all.length +
        " graduates. " +
        all.filter(function (g) {
          return g.eligible && g.reviewed_revision === batch.revision;
        }).length +
        " current proofs approved.",
      body,
    );
    button(
      batch.state === "draft"
        ? "Approve & Issue Certificates"
        : "Resume approved issuance",
      async function () {
        if (batch.state === "draft") {
          if (
            !window.confirm(
              "Approve issuance of " +
                all.length +
                " signed certificates? No emails will be sent.",
            )
          )
            return;
          await api("approve", { batch_id: batch.id });
        }
        for (var g of all) {
          report("Generating and archiving " + g.data.full_name + "…");
          await api("issue", { batch_id: batch.id, id: g.id });
        }
        report(
          "Approved documents are processing on the server. Refresh progress to see archived PDFs and previews.",
        );
        await reload();
      },
    );
    button("Refresh processing progress", async function () {
      await reload();
    });
    all.forEach(function (g) {
      el(
        "p",
        g.data.full_name +
          " — " +
          g.state +
          (g.credential_id ? " · " + g.credential_id : ""),
        body,
      );
    });
    button("Choose delivery →", function () {
      next(6);
    });
  }
  function delivery() {
    el("h3", "6. Choose delivery", body);
    var method = select(
      body,
      "Delivery method",
      [
        { id: "later", label: "Archive Only — Deliver Later" },
        { id: "email", label: "Email Certificates" },
        { id: "print", label: "Print & Hand Out" },
        { id: "both", label: "Email and Print" },
      ],
      deliveryMethod,
    );
    var panel = el("div", undefined, body);
    method.addEventListener("change", show);
    show();
    function show() {
      deliveryMethod = method.value;
      panel.replaceChildren();
      if (method.value === "later") {
        el(
          "p",
          "Certificates remain archived. Return at any time to print or prepare an email.",
          panel,
        );
        return;
      }
      var gs = graduates().filter(function (g) {
        return g.state === "issued";
      });
      if (gs.length !== graduates().length)
        el(
          "p",
          "Some certificates are still processing. Finish issuance before delivering those certificates.",
          panel,
        );
      if (["print", "both"].includes(method.value)) {
        el("h4", "Print official archived certificates", panel);
        var paper = select(
          panel,
          "Paper format",
          [
            { id: "letter", label: "US Letter landscape — 11 × 8.5 in" },
            { id: "a4", label: "A4 landscape — 297 × 210 mm" },
          ],
          "letter",
        );
        button(
          "Print All Certificates",
          async function () {
            save(
              await api(
                "print_pack",
                {
                  ids: gs.map(function (g) {
                    return g.id;
                  }),
                  format: paper.value,
                },
                true,
              ),
              "class-certificates-" + paper.value + ".pdf",
            );
            report(
              "Print pack downloaded. Open the PDF and choose Print. No certificates were marked handed out.",
            );
            await reload();
          },
          panel,
        );
        button(
          "Download individual PDFs as ZIP",
          async function () {
            save(
              await api(
                "print_pack",
                {
                  ids: gs.map(function (g) {
                    return g.id;
                  }),
                  format: paper.value,
                  zip: true,
                },
                true,
              ),
              "certificates.zip",
            );
          },
          panel,
        );
        el(
          "p",
          "Print landscape, with the matching paper size, Actual size / 100%, single-sided. Turn off browser headers and footers. Select the heavy-paper setting supported by your printer and use its recommended feed tray. Check your printer’s stock-weight limits; test one sheet before printing the class.",
          panel,
        );
      }
      gs.forEach(function (g) {
        var card = el("article", undefined, panel, "studio-card");
        el("h4", g.data.full_name + " · " + g.credential_id, card);
        el("p", "Physical delivery: " + g.print_status, card);
        if (["print", "both"].includes(method.value)) {
          button(
            "Print Certificate",
            async function () {
              save(
                await api("download", { ids: [g.id], format: "letter" }, true),
                g.credential_id + ".pdf",
              );
              await reload();
            },
            card,
          );
          ["printed", "handed_out", "not_collected"].forEach(function (status) {
            button(
              "Mark " + status.replace("_", " "),
              async function () {
                if (
                  status === "handed_out" &&
                  !window.confirm(
                    "Confirm you physically handed this certificate to " +
                      g.data.full_name +
                      "?",
                  )
                )
                  return;
                await api("print", { ids: [g.id], status: status });
                await reload();
              },
              card,
            );
          });
        }
        if (["email", "both"].includes(method.value)) {
          var existing = model.deliveries.filter(function (d) {
            return d.graduate_id === g.id;
          });
          existing.forEach(function (d) {
            el(
              "p",
              "Email " +
                d.state +
                " · " +
                (d.provider_id || d.id) +
                (d.error ? " · " + d.error : ""),
              card,
            );
            if (d.state === "prepared") {
              var details = el("details", undefined, card);
              el(
                "summary",
                "Review recipient, message and attachment",
                details,
              );
              el(
                "pre",
                "To: " +
                  d.message.to +
                  "\nSubject: " +
                  d.message.subject +
                  "\nAttachment: " +
                  d.message.attachment_name +
                  "\n\n" +
                  d.message.body,
                details,
              );
              button(
                "Inspect attached PDF",
                async function () {
                  save(
                    await api("download", { ids: [g.id], purpose: "inspect" }, true),
                    d.message.attachment_name,
                  );
                },
                card,
              );
              button(
                "Approve & send this email",
                async function () {
                  if (
                    !window.confirm(
                      "Send one certificate to " + d.message.to + "?",
                    )
                  )
                    return;
                  var r = await api("send_email", { id: d.id });
                  report("Provider result: " + r.state, r.state !== "sent");
                  await reload();
                },
                card,
              );
              button(
                "Exclude this recipient",
                async function () {
                  await api("exclude_email", { id: d.id });
                  await reload();
                },
                card,
              );
            }
            if (["uncertain", "sending"].includes(d.state))
              button(
                "Reconcile provider outcome",
                async function () {
                  var evidence = window.prompt(
                    "Check Hostinger Sent first. Enter provider evidence / message identifier:",
                  );
                  if (!evidence) return;
                  var sent = window.confirm(
                    "Did Hostinger definitively confirm the message was sent? Cancel means definitively NOT sent.",
                  );
                  if (
                    !window.confirm(
                      "Record the verified provider outcome? Do not proceed if uncertain.",
                    )
                  )
                    return;
                  await api("reconcile_email", {
                    id: d.id,
                    state: sent ? "sent" : "failed",
                    provider_id: evidence,
                    reason: evidence,
                  });
                  await reload();
                },
                card,
              );
          });
          var sent = existing.some(function (d) {
            return d.state === "sent";
          });
          button(
            sent ? "Prepare explicit resend" : "Prepare personalized email",
            async function () {
              var reason = sent
                ? window.prompt("Reason for explicit resend:")
                : "";
              if (sent && !reason) return;
              var subject = window.prompt(
                "Email subject",
                batch.snapshot.email_subject || emailSubject,
              );
              if (subject === null) return;
              var content = window.prompt(
                "Message template (personalization tokens are expanded)",
                batch.snapshot.email_body || emailBody,
              );
              if (content === null) return;
              await api("prepare_email", {
                id: g.id,
                subject: subject,
                body: content,
                resend: sent,
                reason: reason,
              });
              await reload();
            },
            card,
          );
        }
      });
      if (["email", "both"].includes(method.value))
        button(
          "Approve prepared delivery batch",
          async function () {
            var ds = model.deliveries.filter(function (d) {
              return (
                d.state === "prepared" &&
                gs.some(function (g) {
                  return g.id === d.graduate_id;
                })
              );
            });
            if (!ds.length) throw Error("Prepare and review messages first");
            if (
              !window.confirm(
                "Send " +
                  ds.length +
                  " individually addressed messages, each with exactly its matching PDF?",
              )
            )
              return;
            for (var d of ds) {
              var r = await api("send_email", { id: d.id });
              if (r.state !== "sent") {
                report(
                  "Delivery stopped: " +
                    r.state +
                    ". Review results before continuing.",
                  true,
                );
                break;
              }
            }
            await reload();
          },
          panel,
        );
    }
    button("Completion report →", function () {
      next(7);
    });
  }
  function results() {
    el("h3", "7. Issuance and delivery report", body);
    var rows = graduates().map(function (g) {
      return {
        graduate: g.data.full_name,
        email: g.data.email,
        credential_id: g.credential_id,
        issuance: g.state,
        archive: g.state === "issued" ? "PDF + preview registered" : "Pending",
        print_status: g.print_status,
        handed_at: g.handed_at,
        handed_by: g.handed_by,
        email_status: model.deliveries
          .filter(function (d) {
            return d.graduate_id === g.id;
          })
          .map(function (d) {
            return d.state;
          })
          .join("; "),
      };
    });
    var pre = el("pre", JSON.stringify(rows, null, 2), body);
    pre.className = "studio-report";
    button("Download report (JSON)", function () {
      save(
        new Blob(
          [
            JSON.stringify(
              {
                batch: batch,
                graduates: rows,
                delivery_records: model.deliveries.filter(function (d) {
                  return rows.some(function (r) {
                    return (
                      r.credential_id &&
                      model.graduates.some(function (g) {
                        return (
                          g.id === d.graduate_id &&
                          g.credential_id === r.credential_id
                        );
                      })
                    );
                  });
                }),
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
        "certificate-report.json",
      );
    });
    graduates()
      .filter(function (g) {
        return g.state === "issued";
      })
      .forEach(function (g) {
        var card = el("div", undefined, body, "studio-card");
        el("p", g.data.full_name + " · " + g.credential_id, card);
        var a = el("a", "View verification", card);
        a.href = "/verify/" + g.credential_id;
        a.target = "_blank";
        a.rel = "noopener";
        button(
          "Correct issued certificate",
          async function () {
            var reason = window.prompt("Audit reason for correction:");
            if (!reason) return;
            var name = window.prompt("Correct full name", g.data.full_name);
            if (name === null) return;
            var email = window.prompt("Correct email", g.data.email || "");
            if (email === null) return;
            var r = await api("correct", {
              id: g.id,
              reason: reason,
              graduate: Object.assign({}, g.data, {
                full_name: name,
                email: email,
              }),
            });
            model = await api("list");
            batch = model.batches.find(function (b) {
              return b.id === r.id;
            });
            report(
              "Correction draft saved. Approve eligibility, review and issue. The credential ID is retained.",
            );
            next(3);
          },
          card,
        );
        button(
          "Revoke credential",
          async function () {
            var reason = window.prompt("Reason for revocation (required):");
            if (!reason) return;
            if (
              !window.confirm(
                "Revoke " + g.credential_id + "? Its history will be retained.",
              )
            )
              return;
            await api("revoke", {
              credential_id: g.credential_id,
              reason: reason,
            });
            report("Credential revoked.");
          },
          card,
        );
      });
    button("Refresh report", reload);
  }
  // Offer corrections from the main credential register, including the nine
  // historically imported Foundations credentials. This uses the SAME audited
  // Studio correction/draft/approval pipeline as the Completion Report.
  // It never PATCHes credentials or replaces a PDF directly.
  window.openStudioCorrection = function (row) {
    run(async function () {
      root.hidden = false;
      await reload();
      var matching = model.graduates.filter(function (g) {
        return g.credential_id === row.credential_id;
      });
      var pending = matching.find(function (g) {
        return g.correction && g.state !== "issued";
      });
      var chosenBatch;
      if (pending) {
        chosenBatch = model.batches.find(function (b) {
          return b.id === pending.batch_id;
        });
        report("An existing correction draft is ready for your review. The original certificate ID is preserved.");
      } else {
        // Only correct the version currently published on the verifier.
        var current = matching.find(function (g) {
          return g.state === "issued" && g.master_path === row.pdf_path;
        });
        if (!current) {
          throw Error("No current Studio-issued document is linked for this certificate. Nothing was changed.");
        }
        var reason = window.prompt("Reason for correcting " + row.credential_id + ":");
        if (!reason || !reason.trim()) return;
        var name = window.prompt("Correct name exactly as it should be printed:", current.data.full_name);
        if (name === null) return;
        var email = window.prompt("Recipient email (unchanged unless necessary):", current.data.email || "");
        if (email === null) return;
        var created = await api("correct", {
          id: current.id,
          reason: reason.trim(),
          graduate: Object.assign({}, current.data, {
            full_name: name.trim(),
            email: email.trim()
          })
        });
        model = await api("list");
        chosenBatch = model.batches.find(function (b) {
          return b.id === created.id;
        });
        report("Correction draft created. Review the proof, approve issuance, and retain the original credential ID.");
      }
      if (!chosenBatch) throw Error("Could not locate the correction batch.");
      batch = chosenBatch;
      cohort = model.cohorts.find(function (h) { return h.id === batch.cohort_id; });
      course = cohort && model.courses.find(function (c) { return c.id === cohort.course_id; });
      next(batch.state === "draft" ? 3 : 5);
      root.scrollIntoView({ behavior: "smooth" });
    });
  };
  document.getElementById("studio-open").addEventListener("click", function () {
    run(async function () {
      root.hidden = false;
      var h = await api("health");
      await reload();
      report(
        h.email_configured
          ? "Studio ready."
          : "Studio ready. Email sending requires the server-side Hostinger API token; drafts and printing remain available.",
        !h.email_configured,
      );
      root.scrollIntoView({ behavior: "smooth" });
    });
  });
  document
    .getElementById("studio-close")
    .addEventListener("click", function () {
      root.hidden = true;
    });
})();
