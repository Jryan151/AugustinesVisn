-- =====================================================================
-- stress/patterns.sql — what the booking data can already tell the photographer.
--
-- Run against a COPY of a database (never the live file while the app writes to it):
--   sqlite3 -header -column copy.sqlite < stress/patterns.sql
-- (or: node stress/patterns.js copy.sqlite)
-- Times are stored in UTC; Phoenix is UTC-7 all year, so local = datetime(x, '-7 hours').
-- "Real" bookings = paid ones: booked, prepped, shot, editing, delivered (+ cancelled after paying).
-- =====================================================================

-- @demand_by_day: which weekdays and sessions fill
SELECT CASE strftime('%w', local_date) WHEN '0' THEN 'Sun' WHEN '1' THEN 'Mon' WHEN '2' THEN 'Tue' WHEN '3' THEN 'Wed'
         WHEN '4' THEN 'Thu' WHEN '5' THEN 'Fri' ELSE 'Sat' END AS day, period, COUNT(*) AS sessions
FROM bookings WHERE status IN ('booked','prepped','shot','editing','delivered')
GROUP BY strftime('%w', local_date), period ORDER BY sessions DESC;

-- @demand_by_month
SELECT substr(local_date, 1, 7) AS month, COUNT(*) AS sessions, SUM(price_cents) / 100 AS revenue
FROM bookings WHERE status IN ('booked','prepped','shot','editing','delivered')
GROUP BY month ORDER BY month;

-- @package_mix
SELECT p.name AS package, COUNT(*) AS sessions, ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM bookings WHERE status IN ('booked','prepped','shot','editing','delivered')), 1) AS pct,
       SUM(b.price_cents) / 100 AS revenue
FROM bookings b JOIN packages p ON p.id = b.package_id
WHERE b.status IN ('booked','prepped','shot','editing','delivered') GROUP BY p.id ORDER BY sessions DESC;

-- @lead_time: how far ahead people book (days between booking and the shoot)
SELECT CASE WHEN d < 3 THEN '0-2 days' WHEN d < 7 THEN '3-6 days' WHEN d < 14 THEN '1-2 weeks' WHEN d < 30 THEN '2-4 weeks' ELSE '30+ days' END AS ahead,
       COUNT(*) AS sessions
FROM (SELECT julianday(start_at) - julianday(created_at) AS d FROM bookings WHERE status IN ('booked','prepped','shot','editing','delivered'))
GROUP BY ahead ORDER BY MIN(d);

-- @sell_out_speed: weeks that hit the weekly cap, and how many days before the week began the last spot went
WITH wk AS (
  SELECT date(local_date, '-' || ((CAST(strftime('%w', local_date) AS INT) + 6) % 7) || ' days') AS week, created_at
  FROM bookings WHERE status IN ('booked','prepped','shot','editing','delivered')
), ranked AS (SELECT week, created_at, ROW_NUMBER() OVER (PARTITION BY week ORDER BY created_at) AS n, COUNT(*) OVER (PARTITION BY week) AS total FROM wk)
SELECT COUNT(*) AS full_weeks, ROUND(AVG(julianday(week) - julianday(created_at)), 1) AS avg_days_before_week_it_filled,
       (SELECT COUNT(DISTINCT week) FROM wk) AS weeks_with_any_booking
FROM ranked WHERE n = total AND total >= (SELECT json_extract(value, '$.weeklyCap') FROM settings WHERE key = 'availability');

-- @hold_conversion: holds that turned into paid sessions, by payment method
SELECT pay_method, COUNT(*) AS holds,
       SUM(paid_at IS NOT NULL) AS paid, SUM(paid_at IS NULL AND status IN ('expired','hold')) AS never_paid,
       ROUND(100.0 * SUM(paid_at IS NOT NULL) / COUNT(*), 1) AS paid_pct
FROM bookings GROUP BY pay_method;

-- @zelle_wait: how long a Zelle deposit takes to be confirmed (hours from booking to confirmed)
SELECT COUNT(*) AS confirmed, ROUND(AVG((julianday(paid_at) - julianday(created_at)) * 24), 1) AS avg_hours,
       ROUND(MAX((julianday(paid_at) - julianday(created_at)) * 24), 1) AS slowest_hours
FROM bookings WHERE pay_method = 'zelle' AND paid_at IS NOT NULL;

-- @prep_fill: how many clients fill in the shoot details, and how soon
SELECT COUNT(*) AS paid_sessions, SUM(prepped_at IS NOT NULL) AS prepped,
       ROUND(100.0 * SUM(prepped_at IS NOT NULL) / COUNT(*), 1) AS prepped_pct,
       ROUND(AVG((julianday(prepped_at) - julianday(paid_at)) * 24), 1) AS avg_hours_after_paying,
       SUM(prepped_at IS NULL AND julianday(start_at) - julianday('now') BETWEEN 0 AND 3) AS shoots_in_3_days_with_no_prep
FROM bookings WHERE status IN ('booked','prepped','shot','editing','delivered');

-- @balance_outstanding: delivered galleries still locked, and for how long
SELECT COUNT(*) AS locked_galleries, SUM(price_cents - deposit_cents) / 100 AS dollars_waiting,
       ROUND(AVG(julianday('now') - julianday(delivered_at)), 1) AS avg_days_waiting,
       SUM(julianday('now') - julianday(delivered_at) > 14) AS waiting_over_2_weeks
FROM bookings WHERE status = 'delivered' AND balance_paid_at IS NULL AND price_cents > deposit_cents;

-- @balance_paid_how: how balances get paid, and how fast after delivery
SELECT balance_paid_by AS paid_by, COUNT(*) AS n, ROUND(AVG(julianday(balance_paid_at) - julianday(delivered_at)), 1) AS avg_days_after_delivery
FROM bookings WHERE balance_paid_at IS NOT NULL AND delivered_at IS NOT NULL GROUP BY balance_paid_by ORDER BY n DESC;

-- @repeat_clients
WITH c AS (SELECT lower(client_email) AS email, COUNT(*) AS n FROM bookings WHERE status IN ('booked','prepped','shot','editing','delivered') GROUP BY email)
SELECT COUNT(*) AS clients, SUM(n > 1) AS repeat_clients, ROUND(100.0 * SUM(n > 1) / COUNT(*), 1) AS repeat_pct,
       ROUND(100.0 * SUM(CASE WHEN n > 1 THEN n ELSE 0 END) / SUM(n), 1) AS pct_of_sessions_from_repeats
FROM c;

-- @repeat_package_moves: what returning clients book next
WITH s AS (
  SELECT lower(b.client_email) AS email, p.name AS pkg, b.start_at,
         LAG(p.name) OVER (PARTITION BY lower(b.client_email) ORDER BY b.start_at) AS prev,
         LAG(b.start_at) OVER (PARTITION BY lower(b.client_email) ORDER BY b.start_at) AS prev_at
  FROM bookings b JOIN packages p ON p.id = b.package_id WHERE b.status IN ('booked','prepped','shot','editing','delivered'))
SELECT prev AS first_package, pkg AS next_package, COUNT(*) AS n, ROUND(AVG(julianday(start_at) - julianday(prev_at))) AS avg_days_between
FROM s WHERE prev IS NOT NULL GROUP BY prev, pkg ORDER BY n DESC;

-- @turnaround: shoot to gallery, against what each package promises
SELECT p.name AS package, p.turnaround_days AS promised, COUNT(*) AS delivered,
       ROUND(AVG(julianday(b.delivered_at) - julianday(b.end_at)), 1) AS avg_days,
       ROUND(100.0 * SUM(julianday(b.delivered_at) - julianday(b.end_at) <= p.turnaround_days) / COUNT(*), 1) AS on_time_pct
FROM bookings b JOIN packages p ON p.id = b.package_id WHERE b.status = 'delivered' GROUP BY p.id;

-- @work_in_progress: what's on the photographer's plate right now
SELECT status, COUNT(*) AS n,
       SUM(status IN ('shot','editing') AND julianday('now') - julianday(end_at) > (SELECT turnaround_days FROM packages WHERE id = package_id)) AS overdue
FROM bookings WHERE status IN ('hold','booked','prepped','shot','editing','needs_refund') GROUP BY status;

-- @delivery_rhythm: when the photographer sends galleries (local weekday and hour) — shows editing habits
SELECT CASE strftime('%w', datetime(delivered_at, '-7 hours')) WHEN '0' THEN 'Sun' WHEN '1' THEN 'Mon' WHEN '2' THEN 'Tue' WHEN '3' THEN 'Wed'
         WHEN '4' THEN 'Thu' WHEN '5' THEN 'Fri' ELSE 'Sat' END AS day,
       CASE WHEN CAST(strftime('%H', datetime(delivered_at, '-7 hours')) AS INT) < 12 THEN 'morning'
            WHEN CAST(strftime('%H', datetime(delivered_at, '-7 hours')) AS INT) < 18 THEN 'afternoon' ELSE 'night' END AS part, COUNT(*) AS galleries
FROM bookings WHERE delivered_at IS NOT NULL GROUP BY day, part ORDER BY galleries DESC LIMIT 8;

-- @cancellations
SELECT COUNT(*) AS cancelled, ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM bookings WHERE paid_at IS NOT NULL), 1) AS pct_of_paid,
       (SELECT COUNT(*) FROM bookings WHERE status = 'needs_refund') AS paid_too_late
FROM bookings WHERE status = 'cancelled' AND paid_at IS NOT NULL;

-- @payment_mix: deposits and balances by how they were paid
SELECT 'deposit' AS what, pay_method AS how, COUNT(*) AS n FROM bookings WHERE paid_at IS NOT NULL GROUP BY pay_method
UNION ALL
SELECT 'balance', COALESCE(balance_paid_by, 'unpaid / at the shoot'), COUNT(*) FROM bookings WHERE status = 'delivered' GROUP BY balance_paid_by;

-- @fee_model: per-use ($5 each time an online feature does the work) vs unlimited ($15 a month), month by month.
-- A session "uses" the paid features if its deposit or balance went through Stripe or it was delivered through the site's gallery.
WITH m AS (
  SELECT substr(local_date, 1, 7) AS month,
         SUM(pay_method = 'card' OR balance_paid_by = 'online' OR gallery_url LIKE '%/gallery/%') AS fee_uses,
         COUNT(*) AS sessions
  FROM bookings WHERE status IN ('booked','prepped','shot','editing','delivered') GROUP BY month)
SELECT month, sessions, fee_uses, fee_uses * 5 AS per_use_dollars, 15 AS unlimited_dollars,
       CASE WHEN fee_uses * 5 > 15 THEN 'unlimited is cheaper' WHEN fee_uses * 5 = 15 THEN 'same' ELSE 'per-use is cheaper' END AS better_for_him
FROM m ORDER BY month;
