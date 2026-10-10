-- Category names are unique case-insensitively, including trashed rows (restore never collides).
-- Pre-launch: categories are empty (no seeds, step 41), so no existing duplicates can block this.
CREATE UNIQUE INDEX categories_name_normalized ON categories (lower(name));
