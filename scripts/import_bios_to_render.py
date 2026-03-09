import json
import os
from pathlib import Path
import psycopg

DATABASE_URL = os.environ["DATABASE_URL"]
JSON_PATH = os.environ["JSON_PATH"]

TABLE = "users"

def valid_x_id(x):
    if not x:
        return False
    s = str(x)
    if s.startswith("manual:"):
        return False
    return True

def main():
    data = json.loads(Path(JSON_PATH).read_text(encoding="utf-8"))
    users = data["users"]

    updated = 0
    skipped = 0
    not_found = 0

    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:

            for u in users:

                bio = u.get("bio")
                created = u.get("account_created_at")
                x_id = u.get("x_user_id")
                handle = u.get("handle")

                # skip rows with nothing useful
                if bio is None and created is None:
                    skipped += 1
                    continue

                updated_rows = 0

                if valid_x_id(x_id):

                    fields = []
                    params = []

                    if bio is not None:
                        fields.append("bio = %s")
                        params.append(bio)

                    if created is not None:
                        fields.append("account_created_at = %s")
                        params.append(created)

                    params.append(str(x_id))

                    sql = f"""
                    UPDATE {TABLE}
                    SET {", ".join(fields)}
                    WHERE x_user_id = %s
                    """

                    cur.execute(sql, params)
                    updated_rows = cur.rowcount

                if updated_rows == 0 and handle:

                    fields = []
                    params = []

                    if bio is not None:
                        fields.append("bio = %s")
                        params.append(bio)

                    if created is not None:
                        fields.append("account_created_at = %s")
                        params.append(created)

                    params.append(handle.lower())

                    sql = f"""
                    UPDATE {TABLE}
                    SET {", ".join(fields)}
                    WHERE LOWER(handle) = %s
                    """

                    cur.execute(sql, params)
                    updated_rows = cur.rowcount

                if updated_rows > 0:
                    updated += updated_rows
                    print("UPDATED:", handle)
                else:
                    not_found += 1
                    print("NOT FOUND:", handle)

        conn.commit()

    print()
    print("Updated:", updated)
    print("Skipped:", skipped)
    print("Not found:", not_found)

if __name__ == "__main__":
    main()
