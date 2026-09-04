(define (domain deliveroo)
  (:requirements :strips :typing)

  ;; `crate-tile` is the tile type a crate may be shoved onto (Deliveroo tile types "5" and
  ;; "5!"). Declaring it as a subtype of `tile` lets pyperplan ground the push action over
  ;; those tiles only, which keeps the grounded problem small on crate-heavy maps.
  (:types
    tile - object
    crate-tile - tile
    parcel - object
  )

  (:predicates
    (at-agent ?t - tile)
    (at-parcel ?p - parcel ?t - tile)
    (carrying ?p - parcel)
    (delivered ?p - parcel)
    (delivery ?t - tile)
    (adjacent ?from - tile ?to - tile)
    (at-crate ?t - tile)
    (crate-free ?t - tile)
    (push-line ?from - tile ?through - tile ?to - crate-tile)
  )

  (:action move
    :parameters (?from - tile ?to - tile)
    :precondition (and (at-agent ?from) (adjacent ?from ?to) (crate-free ?to))
    :effect (and (not (at-agent ?from)) (at-agent ?to))
  )

  ;; Pushing is an ordinary move that happens to shove a crate one tile further along the same
  ;; line: the agent ends up where the crate was. `push-line` is static and encodes the
  ;; collinearity that STRIPS cannot compute from `adjacent` alone.
  (:action push
    :parameters (?from - tile ?through - tile ?to - crate-tile)
    :precondition (and (at-agent ?from) (push-line ?from ?through ?to) (at-crate ?through) (crate-free ?to))
    :effect (and (not (at-crate ?through)) (at-crate ?to)
                 (not (crate-free ?to)) (crate-free ?through)
                 (not (at-agent ?from)) (at-agent ?through))
  )

  (:action pickup
    :parameters (?p - parcel ?t - tile)
    :precondition (and (at-agent ?t) (at-parcel ?p ?t))
    :effect (and (carrying ?p) (not (at-parcel ?p ?t)))
  )

  (:action drop
    :parameters (?p - parcel ?t - tile)
    :precondition (and (at-agent ?t) (carrying ?p) (delivery ?t))
    :effect (and (delivered ?p) (not (carrying ?p)))
  )
)
