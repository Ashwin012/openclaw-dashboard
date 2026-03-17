#!/usr/bin/env python3
"""Fetch Pronote data and save to children.json for the dashboard."""
import json, datetime, sys, os

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')

def fetch():
    import pronotepy

    creds_path = os.path.expanduser('/home/node/.openclaw/credentials/pronote.json')
    with open(creds_path) as f:
        creds = json.load(f)

    client = pronotepy.ParentClient(
        creds['url'],
        username=creds['username'],
        password=creds['password']
    )

    if not client.logged_in:
        print("❌ Login failed", file=sys.stderr)
        sys.exit(1)

    today = datetime.date.today()
    tomorrow = today + datetime.timedelta(days=1)
    week_end = today + datetime.timedelta(days=7)

    children_data = []

    for child in client.children:
        client.set_child(child)
        child_info = {
            "name": child.name,
            "class": child.class_name,
            "homework": [],
            "grades": [],
            "timetable_today": [],
            "timetable_tomorrow": [],
            "absences": [],
            "information": []
        }

        # Homework (next 7 days)
        try:
            hw_list = client.homework(today - datetime.timedelta(days=1), week_end)
            for h in hw_list:
                child_info["homework"].append({
                    "date": str(h.date),
                    "subject": h.subject.name if h.subject else "?",
                    "description": h.description[:200] if h.description else "",
                    "done": h.done
                })
        except Exception as e:
            child_info["homework_error"] = str(e)

        # Timetable today
        try:
            lessons = client.lessons(today, today + datetime.timedelta(days=1))
            for l in sorted(lessons, key=lambda x: x.start):
                child_info["timetable_today"].append({
                    "start": l.start.strftime('%H:%M'),
                    "end": l.end.strftime('%H:%M'),
                    "subject": l.subject.name if l.subject else "N/A",
                    "canceled": l.canceled,
                    "room": getattr(l, 'classroom', '') or ''
                })
        except Exception as e:
            child_info["timetable_today_error"] = str(e)

        # Timetable tomorrow
        try:
            lessons = client.lessons(tomorrow, tomorrow + datetime.timedelta(days=1))
            for l in sorted(lessons, key=lambda x: x.start):
                child_info["timetable_tomorrow"].append({
                    "start": l.start.strftime('%H:%M'),
                    "end": l.end.strftime('%H:%M'),
                    "subject": l.subject.name if l.subject else "N/A",
                    "canceled": l.canceled,
                    "room": getattr(l, 'classroom', '') or ''
                })
        except Exception as e:
            child_info["timetable_tomorrow_error"] = str(e)

        # Grades (all periods)
        try:
            for period in client.periods:
                try:
                    for g in period.grades:
                        child_info["grades"].append({
                            "date": str(g.date),
                            "subject": g.subject.name if g.subject else "?",
                            "grade": str(g.grade),
                            "out_of": str(g.out_of),
                            "coefficient": str(getattr(g, 'coefficient', ''))
                        })
                except:
                    pass
        except Exception as e:
            child_info["grades_error"] = str(e)

        # Absences (current period)
        try:
            for period in client.periods:
                try:
                    for a in period.absences:
                        child_info["absences"].append({
                            "from": str(a.from_date),
                            "to": str(a.to_date),
                            "justified": a.justified,
                            "reasons": getattr(a, 'reasons', [])
                        })
                except:
                    pass
        except Exception as e:
            child_info["absences_error"] = str(e)

        children_data.append(child_info)

    result = {
        "updatedAt": datetime.datetime.now().isoformat(),
        "children": children_data
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    out_path = os.path.join(DATA_DIR, 'children.json')
    with open(out_path, 'w') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print(f"✅ Saved {len(children_data)} children to {out_path}")
    # Also print to stdout for debugging
    print(json.dumps(result, indent=2, ensure_ascii=False))

if __name__ == '__main__':
    fetch()
