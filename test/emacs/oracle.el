;;; oracle.el --- Dump Org-roam's view of a directory as JSON  -*- lexical-binding: t; -*-

;; Usage: emacs --batch -Q -L <deps>... -l oracle.el <directory> <output.json>
;;
;; Runs only in CI, as a separate program (design.md, Decisions 8 and 9). The database lives in a
;; temporary directory, so nothing is written to the directory being synced.

;;; Code:

(require 'json)
(require 'subr-x)
(require 'org)
(require 'org-roam)

(defun oracle--sorted (values)
  "Return VALUES, a list of strings, as a sorted vector."
  (vconcat (sort (copy-sequence values) #'string<)))

(defun oracle--line-start (file pos)
  "Return the start of the line holding POS in FILE.
Org-roam can record a position inside a heading line, past its stars."
  (with-temp-buffer
    (insert-file-contents file)
    (goto-char pos)
    (line-beginning-position)))

(defun oracle--backlinks ()
  "Return every node's backlinks, through Org-roam's own lookup."
  (let (backlinks)
    (pcase-dolist (`(,id) (org-roam-db-query [:select id :from nodes]))
      (dolist (backlink (org-roam-backlinks-get (org-roam-node-from-id id)))
        (push `((source . ,(org-roam-node-id (org-roam-backlink-source-node backlink)))
                (dest . ,id))
              backlinks)))
    (vconcat (nreverse backlinks))))

(defun oracle--descriptions (root)
  "Return the description Org parses for each `id:' link in the files under ROOT."
  (let (descriptions)
    (dolist (file (org-roam-list-files))
      (with-temp-buffer
        (insert-file-contents file)
        (delay-mode-hooks (org-mode))
        (org-element-map (org-element-parse-buffer) 'link
          (lambda (link)
            (let ((begin (org-element-property :contents-begin link))
                  (end (org-element-property :contents-end link)))
              (when (and begin (equal (org-element-property :type link) "id"))
                (push `((file . ,(file-relative-name file root))
                        (dest . ,(org-element-property :path link))
                        (description . ,(buffer-substring-no-properties begin end)))
                      descriptions)))))))
    (vconcat (nreverse descriptions))))

(defun oracle--dump (root)
  "Return what Org-roam's database holds for ROOT, with paths relative to it."
  (let ((tags (make-hash-table :test #'equal)))
    (pcase-dolist (`(,node ,tag) (org-roam-db-query [:select [node-id tag] :from tags]))
      (push tag (gethash node tags)))
    `((versions . ((emacs . ,emacs-version)
                   (org . ,(org-version))
                   (org-roam . ,(string-trim (or (ignore-errors (org-roam-version)) "unknown")))))
      (files . ,(oracle--sorted
                 (mapcar (lambda (row) (file-relative-name (car row) root))
                         (org-roam-db-query [:select file :from files]))))
      (nodes . ,(vconcat
                 (mapcar (pcase-lambda (`(,id ,file ,level ,pos ,title))
                           `((id . ,id)
                             (file . ,(file-relative-name file root))
                             (level . ,level)
                             (pos . ,(oracle--line-start file pos))
                             (title . ,title)
                             (slug . ,(org-roam-node-slug (org-roam-node-create :title title)))
                             (tags . ,(oracle--sorted (gethash id tags)))))
                         (org-roam-db-query
                          [:select [id file level pos title] :from nodes
                           :order-by [(asc file) (asc pos)]]))))
      (links . ,(vconcat
                 (mapcar (pcase-lambda (`(,source ,dest))
                           `((source . ,source) (dest . ,dest)))
                         (org-roam-db-query
                          [:select [source dest] :from links :where (= type "id")
                           :order-by [(asc source) (asc pos)]]))))
      (backlinks . ,(oracle--backlinks))
      (descriptions . ,(oracle--descriptions root)))))

(defun oracle-run (directory output)
  "Sync DIRECTORY with Org-roam, and write its nodes and links to OUTPUT as JSON."
  (let* ((root (file-name-as-directory (file-truename directory)))
         (scratch (make-temp-file "oracle" t))
         (org-roam-directory root)
         (org-roam-db-location (expand-file-name "org-roam.db" scratch))
         (org-id-locations-file (expand-file-name "org-id-locations" scratch)))
    ;; A duplicate ID goes to whichever file syncs first, so that order must not vary between runs.
    (advice-add 'org-roam-list-files :filter-return
                (lambda (files) (sort files #'string<)))
    (org-roam-db-sync)
    (let ((coding-system-for-write 'utf-8-unix))
      (with-temp-file output
        (insert (json-serialize (oracle--dump root)))))
    (org-roam-db--close-all)
    (delete-directory scratch t)))

(oracle-run (pop command-line-args-left) (pop command-line-args-left))

;;; oracle.el ends here
